/**
 * Komga Annotations Service — aplicación Express (testeable)
 *
 * Pipeline: imagen de página → OCR (qwen3-omni, texto plano) → DeepSeek V4 Flash (furigana + kanjis)
 *
 * Este módulo expone `createApp()` con dependencias inyectables para poder testear
 * el servicio sin arrancar un servidor real ni llamar a la API de LiteLLM.
 *
 * `server.js` es el punto de arranque: importa createApp() y hace app.listen().
 *
 * Endpoints:
 *   POST /api/annotations            body: { bookId, pageNumber, image, mimeType }
 *   GET  /api/annotations/:bookId/:pageNumber
 *   GET  /api/annotations/:bookId/status
 *   POST /api/annotations/prefetch
 *   GET  /health
 */
import express from 'express'
import cors from 'cors'
import sharp from 'sharp'
import crypto from 'crypto'
import fs from 'fs'
import path from 'path'
import os from 'os'
import Database from 'better-sqlite3'

/**
 * Crea la aplicación Express con sus dependencias.
 *
 * @param {object} opts
 * @param {Function} [opts.callLiteLLM]  Función que llama al LLM. Por defecto usa la real.
 * @param {string}   [opts.dbPath]       Ruta del fichero SQLite. Por defecto usa un temporal.
 * @param {string}   [opts.liteLLMUrl]   URL base de LiteLLM.
 * @param {string}   [opts.liteLLMApiKey] API key de LiteLLM.
 * @param {string}   [opts.ocrModel]     Modelo OCR.
 * @param {string}   [opts.llmModel]     Modelo LLM.
 * @param {number}   [opts.prefetchCount] Páginas a pre-traducir.
 * @param {string[]} [opts.allowedOrigins] Orígenes CORS permitidos.
 *
 * @returns {{ app: import('express').Express, db: Database.Database,
 *            getStored: Function, storeResult: Function, stmtCount: Function }}
 */
export function createApp(opts = {}) {
  const {
    callLiteLLM: injectedCallLiteLLM,
    dbPath,
    liteLLMUrl = process.env.LITELLM_URL || 'https://ollama.khlloreda.com',
    liteLLMApiKey = process.env.LITELLM_API_KEY || 'sk-litellm-8d13346fba6cd9a78eee874cb8ef4e88bf6c4921',
    ocrModel = process.env.OCR_MODEL || 'qwen3-omni',
    llmModel = process.env.LLM_MODEL || 'deepseek-v4-flash',
    prefetchCount = Number(process.env.PREFETCH_COUNT || 3),
    allowedOrigins = (process.env.ALLOWED_ORIGINS || '').split(',').map((s) => s.trim()).filter(Boolean),
  } = opts

  const app = express()

  // CORS: permitir el origen del frontend (Komga) con credentials.
  app.use(
    cors({
      origin(origin, callback) {
        if (!origin || allowedOrigins.length === 0 || allowedOrigins.includes(origin)) {
          return callback(null, true)
        }
        return callback(new Error('Not allowed by CORS'))
      },
      credentials: true,
    }),
  )
  app.use(express.json({ limit: '25mb' }))

  // Log de todas las peticiones entrantes (para diagnóstico)
  app.use((req, _res, next) => {
    console.log(`[annotations] REQ ${req.method} ${req.path} origin=${req.headers.origin || 'none'}`)
    next()
  })

  // ---------------------------------------------------------------------------
  // Persistencia SQLite
  // ---------------------------------------------------------------------------
  const DATA_DIR = dbPath ? path.dirname(dbPath) : fs.mkdtempSync(path.join(os.tmpdir(), 'komga-annot-'))
  fs.mkdirSync(DATA_DIR, { recursive: true })
  const db = new Database(dbPath || path.join(DATA_DIR, 'annotations.db'))
  db.pragma('journal_mode = WAL')
  db.exec(`
    CREATE TABLE IF NOT EXISTS annotations (
      book_id     TEXT NOT NULL,
      page_number INTEGER NOT NULL,
      payload     TEXT NOT NULL,
      created_at  INTEGER NOT NULL,
      PRIMARY KEY (book_id, page_number)
    );
  `)
  const stmtGet = db.prepare('SELECT payload FROM annotations WHERE book_id = ? AND page_number = ?')
  const stmtPut = db.prepare(
    'INSERT OR REPLACE INTO annotations (book_id, page_number, payload, created_at) VALUES (?, ?, ?, ?)',
  )
  const stmtCount = db.prepare('SELECT COUNT(*) AS n FROM annotations')
  const stmtPages = db.prepare('SELECT page_number FROM annotations WHERE book_id = ? ORDER BY page_number')

  function getStored(bookId, pageNumber) {
    const row = stmtGet.get(String(bookId), Number(pageNumber))
    return row ? JSON.parse(row.payload) : null
  }
  function storeResult(bookId, pageNumber, result) {
    stmtPut.run(String(bookId), Number(pageNumber), JSON.stringify(result), Date.now())
  }

  // Caché en memoria por hash de imagen (complementa al store; útil para el prefetch)
  const annotationCache = new Map()
  const CACHE_MAX = 200
  function cacheKey(imageBase64) {
    return crypto.createHash('sha1').update(imageBase64).digest('hex')
  }

  // ---------------------------------------------------------------------------
  // LiteLLM
  // ---------------------------------------------------------------------------
  async function defaultCallLiteLLM(model, messages, { maxTokens = 4096, temperature = 0.1 } = {}) {
    const res = await fetch(`${liteLLMUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${liteLLMApiKey}`,
      },
      body: JSON.stringify({
        model,
        messages,
        max_tokens: maxTokens,
        temperature,
      }),
    })

    if (!res.ok) {
      const text = await res.text()
      throw new Error(`LiteLLM ${model} error ${res.status}: ${text.slice(0, 500)}`)
    }

    const data = await res.json()
    return data.choices?.[0]?.message?.content ?? ''
  }
  const callLiteLLM = injectedCallLiteLLM || defaultCallLiteLLM

  /**
   * Redimensiona la imagen base64 a un tamaño manejable para el OCR.
   * Devuelve { base64, mimeType, width, height, scaleX, scaleY }.
   */
  async function resizeImage(imageBase64, mimeType) {
    try {
      const buf = Buffer.from(imageBase64, 'base64')
      const img = sharp(buf)
      const meta = await img.metadata()
      const maxDim = 1000
      let width = meta.width
      let height = meta.height
      let scaleX = 1
      let scaleY = 1
      if (width > maxDim || height > maxDim) {
        const scale = Math.min(maxDim / width, maxDim / height)
        scaleX = scale
        scaleY = scale
        width = Math.round(width * scale)
        height = Math.round(height * scale)
      }
      const outBuf = await img.resize(width, height).jpeg({ quality: 85 }).toBuffer()
      return {
        base64: outBuf.toString('base64'),
        mimeType: 'image/jpeg',
        width,
        height,
        scaleX,
        scaleY,
      }
    } catch (e) {
      return { base64: imageBase64, mimeType: mimeType || 'image/png', width: 0, height: 0, scaleX: 1, scaleY: 1 }
    }
  }

  /**
   * Paso 1: OCR con qwen3-omni (fiable, extrae texto de todas las páginas).
   * Devuelve texto japonés plano. No devuelve bbox fiables (el overlay es panel lateral).
   */
  async function runOcr(imageBase64, mimeType) {
    const resized = await resizeImage(imageBase64, mimeType)
    const content = [
      { type: 'text', text: 'Extract all the Japanese text from this manga page, line by line, in reading order. Output only the text, no commentary.' },
      { type: 'image_url', image_url: { url: `data:${resized.mimeType};base64,${resized.base64}` } },
    ]
    const ocrText = await callLiteLLM(ocrModel, [{ role: 'user', content }], { maxTokens: 4096, temperature: 0 })
    return { ocrText, scaleX: resized.scaleX, scaleY: resized.scaleY }
  }

  /**
   * Paso 2: DeepSeek V4 Flash convierte el OCR en JSON estructurado con furigana y kanjis.
   */
  async function runDeepSeek(ocrText) {
    const system = `Eres un asistente experto en japonés. Recibes el texto OCR de una página de manga (texto plano, en orden de lectura).

Debes responder SOLO con JSON válido, sin markdown ni comentarios, con esta estructura:
{
  "blocks": [
    {
      "bbox": [0, 0, 0, 0],
      "original": "texto japonés original (un párrafo o globo de diálogo)",
      "furigana": "texto con lectura en furigana: 漢字(かんじ) para cada kanji",
      "translation": "traducción breve al español",
      "kanji": [
        { "kanji": "漢字", "reading": "かんじ", "meaning": "significado en español" }
      ]
    }
  ]
}

Reglas:
- Divide el texto en bloques lógicos (cada globo de diálogo o párrafo coherente es un bloque).
- "bbox" déjalo en [0,0,0,0] (no se usa para posicionar, el panel es lateral).
- "furigana": para cada kanji añade su lectura en hiragana entre paréntesis justo después.
- "kanji": lista SOLO los kanjis (no hiragana/katakana) que puedan resultar difíciles, con su lectura y significado.
- "translation": traducción natural y breve al español.
- Si un bloque no tiene kanjis, "kanji" será un array vacío.
- No inventes texto: usa exactamente el que viene del OCR.`

    const user = `Texto OCR de la página:\n\n${ocrText}`
    const raw = await callLiteLLM(llmModel, [
      { role: 'system', content: system },
      { role: 'user', content: user },
    ], { maxTokens: 4096, temperature: 0.1 })

    const jsonMatch = raw.match(/\{[\s\S]*\}/)
    if (!jsonMatch) throw new Error(`DeepSeek no devolvió JSON válido: ${raw.slice(0, 300)}`)
    return JSON.parse(jsonMatch[0])
  }

  /**
   * Analiza una página completa (OCR + DeepSeek) y devuelve el resultado.
   * Escala los bbox de vuelta a las coordenadas de la imagen original.
   */
  async function analyzePage(imageBase64, mimeType) {
    const t1 = Date.now()
    const { ocrText, scaleX, scaleY } = await runOcr(imageBase64, mimeType)
    const t2 = Date.now()
    console.log(`[annotations] OCR done in ${t2 - t1}ms, ocrText.length=${ocrText.length}`)
    if (!ocrText || ocrText.trim().length === 0) {
      console.warn('[annotations] WARNING: OCR devolvió VACÍO')
    }

    const result = await runDeepSeek(ocrText)
    const t3 = Date.now()
    console.log(`[annotations] DeepSeek done in ${t3 - t2}ms, blocks=${(result.blocks || []).length}`)
    if (!result.blocks || result.blocks.length === 0) {
      console.warn('[annotations] WARNING: DeepSeek devolvió 0 bloques')
    }

    const invX = 1 / (scaleX || 1)
    const invY = 1 / (scaleY || 1)
    for (const block of (result.blocks || [])) {
      if (Array.isArray(block.bbox) && block.bbox.length === 4) {
        block.bbox = [
          Math.round(block.bbox[0] * invX),
          Math.round(block.bbox[1] * invY),
          Math.round(block.bbox[2] * invX),
          Math.round(block.bbox[3] * invY),
        ]
      }
    }
    return result
  }

  /**
   * Obtiene las anotaciones de una página, usando store → caché → análisis.
   * Si hay que analizar, guarda el resultado en el store y en la caché.
   */
  async function getOrAnalyze(bookId, pageNumber, imageBase64, mimeType) {
    const t0 = Date.now()

    // 1) Store persistente (SQLite)
    const stored = getStored(bookId, pageNumber)
    if (stored) {
      console.log(`[annotations] STORE HIT book=${bookId} page=${pageNumber} in ${Date.now() - t0}ms`)
      return { result: stored, fromStore: true }
    }

    // 2) Caché en memoria por hash de imagen
    const key = imageBase64 ? cacheKey(imageBase64) : null
    if (key && annotationCache.has(key)) {
      const cached = annotationCache.get(key)
      console.log(`[annotations] CACHE HIT in ${Date.now() - t0}ms, blocks=${(cached.blocks || []).length}`)
      storeResult(bookId, pageNumber, cached)
      return { result: cached, fromStore: false }
    }

    // 3) Análisis completo
    const result = await analyzePage(imageBase64, mimeType)

    if (annotationCache.size >= CACHE_MAX) {
      const firstKey = annotationCache.keys().next().value
      annotationCache.delete(firstKey)
    }
    if (key) annotationCache.set(key, result)
    storeResult(bookId, pageNumber, result)

    console.log(`[annotations] TOTAL ${Date.now() - t0}ms (analyzed)`)
    return { result, fromStore: false }
  }

  app.get('/health', (_req, res) => {
    res.json({ status: 'ok', ocrModel, llmModel, stored: stmtCount.get().n })
  })

  // GET /api/annotations/:bookId/status — páginas ya traducidas de un libro
  app.get('/api/annotations/:bookId/status', (req, res) => {
    const { bookId } = req.params
    const rows = stmtPages.all(String(bookId))
    res.json({ bookId: String(bookId), pages: rows.map((r) => r.page_number) })
  })

  // GET /api/annotations/:bookId/:pageNumber — consulta el store sin imagen
  app.get('/api/annotations/:bookId/:pageNumber', (req, res) => {
    const { bookId, pageNumber } = req.params
    const stored = getStored(bookId, pageNumber)
    if (!stored) return res.status(404).json({ error: 'Not cached' })
    res.json(stored)
  })

  // POST /api/annotations — analiza (o devuelve del store) una página
  app.post('/api/annotations', async (req, res) => {
    const { bookId, pageNumber, image, mimeType } = req.body
    if (!image) return res.status(400).json({ error: 'Missing "image" (base64) in body' })
    if (bookId == null || pageNumber == null) {
      return res.status(400).json({ error: 'Missing "bookId" or "pageNumber" in body' })
    }
    try {
      const { result } = await getOrAnalyze(bookId, pageNumber, image, mimeType)
      res.json(result)
    } catch (err) {
      console.error('[annotations] error:', err.message)
      res.status(500).json({ error: err.message })
    }
  })

  // POST /api/annotations/prefetch — analiza en background, responde 202 ya
  app.post('/api/annotations/prefetch', async (req, res) => {
    const { bookId, pageNumber, image, mimeType } = req.body
    if (!image || bookId == null || pageNumber == null) {
      return res.status(400).json({ error: 'Missing bookId/pageNumber/image' })
    }
    // Si ya está en el store, no hacer nada
    if (getStored(bookId, pageNumber)) {
      return res.status(202).json({ status: 'already_cached' })
    }
    // Lanzar en background (no bloquea la respuesta)
    res.status(202).json({ status: 'queued' })
    getOrAnalyze(bookId, pageNumber, image, mimeType)
      .then(() => console.log(`[annotations] PREFETCH done book=${bookId} page=${pageNumber}`))
      .catch((e) => console.error(`[annotations] PREFETCH error book=${bookId} page=${pageNumber}:`, e.message))
  })

  return { app, db, getStored, storeResult, stmtCount }
}
