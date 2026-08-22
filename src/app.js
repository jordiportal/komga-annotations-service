/**
 * Komga Annotations Service — aplicación Express (testeable)
 *
 * Pipeline (2 pasos):
 *   1. OCR con qwen3-omni: extrae el texto plano de la página (rápido).
 *   2. Estructuración con deepseek-v4-flash: furigana + kanjis + traducción.
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

  // --- Jobs de traducción (traducir todo el manga) ---
  db.exec(`
    CREATE TABLE IF NOT EXISTS translation_jobs (
      id           TEXT PRIMARY KEY,
      book_id      TEXT NOT NULL,
      type         TEXT NOT NULL,
      status       TEXT NOT NULL DEFAULT 'pending',
      start_page   INTEGER NOT NULL,
      end_page     INTEGER NOT NULL,
      total_pages  INTEGER NOT NULL,
      done_pages   INTEGER NOT NULL DEFAULT 0,
      failed_pages INTEGER NOT NULL DEFAULT 0,
      created_at   INTEGER NOT NULL,
      updated_at   INTEGER NOT NULL
    );
  `)
  const stmtJobInsert = db.prepare(`
    INSERT INTO translation_jobs (id, book_id, type, status, start_page, end_page, total_pages, done_pages, failed_pages, created_at, updated_at)
    VALUES (?, ?, ?, 'pending', ?, ?, ?, 0, 0, ?, ?)
  `)
  const stmtJobGet = db.prepare('SELECT * FROM translation_jobs WHERE id = ?')
  const stmtJobUpdate = db.prepare(
    'UPDATE translation_jobs SET done_pages = ?, failed_pages = ?, status = ?, updated_at = ? WHERE id = ?',
  )
  const stmtJobList = db.prepare('SELECT * FROM translation_jobs WHERE book_id = ? ORDER BY created_at DESC')

  // --- Anotaciones de texto (EPUB): furigana + traducción por párrafo ---
  // Clave: (book_id, chapter, paragraph) — el párrafo es la unidad, no hay OCR.
  db.exec(`
    CREATE TABLE IF NOT EXISTS text_annotations (
      book_id    TEXT NOT NULL,
      chapter    TEXT NOT NULL,
      paragraph  INTEGER NOT NULL,
      payload    TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      PRIMARY KEY (book_id, chapter, paragraph)
    );
  `)
  const stmtTextGet = db.prepare('SELECT payload FROM text_annotations WHERE book_id = ? AND chapter = ? AND paragraph = ?')
  const stmtTextPut = db.prepare(
    'INSERT OR REPLACE INTO text_annotations (book_id, chapter, paragraph, payload, created_at) VALUES (?, ?, ?, ?, ?)',
  )

  function getTextStored(bookId, chapter, paragraph) {
    const row = stmtTextGet.get(String(bookId), String(chapter), Number(paragraph))
    return row ? JSON.parse(row.payload) : null
  }
  function storeTextResult(bookId, chapter, paragraph, result) {
    stmtTextPut.run(String(bookId), String(chapter), Number(paragraph), JSON.stringify(result), Date.now())
  }

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
      // Carga dinámica de sharp: si el binario nativo no está disponible,
      // devolvemos la imagen sin redimensionar (el OCR funciona igual).
      let sharp
      try {
        sharp = (await import('sharp')).default
      } catch {
        return { base64: imageBase64, mimeType: mimeType || 'image/png', width: 0, height: 0, scaleX: 1, scaleY: 1 }
      }
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
   * Paso 1 — OCR: qwen3-omni extrae el texto plano de la página (rápido).
   * Recibe la imagen y devuelve el texto japonés en orden de lectura.
   */
  async function runOcr(imageBase64, mimeType) {
    const resized = await resizeImage(imageBase64, mimeType)
    const system = `Eres un motor de OCR especializado en japonés. Recibes la imagen de una página de manga.

Debes transcribir TODO el texto que aparece en la imagen, en orden de lectura (derecha a izquierda, arriba a abajo).

Reglas:
- Transcribe exactamente el texto tal y como aparece, sin añadir ni corregir nada.
- Separa cada globo de diálogo o párrafo coherente con un salto de línea.
- No traduzcas, no añadas furigana, no expliques nada: SOLO transcribe el texto japonés.
- Si no hay texto, responde con una línea vacía.`

    const content = [
      { type: 'text', text: system },
      { type: 'image_url', image_url: { url: `data:${resized.mimeType};base64,${resized.base64}` } },
    ]
    const raw = await callLiteLLM(ocrModel, [{ role: 'user', content }], { maxTokens: 2048, temperature: 0.1 })
    return { ocrText: raw.trim(), scaleX: resized.scaleX, scaleY: resized.scaleY }
  }

  /**
   * Paso 2 — Estructuración: deepseek-v4-flash recibe el texto OCR y añade
   * furigana + kanjis + traducción al español. Devuelve el JSON estructurado.
   */
  async function runDeepSeek(ocrText) {
    const system = `Eres un asistente experto en japonés. Recibes el texto OCR de una página de manga (un bloque por línea).

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
- Divide el texto en bloques lógicos (cada línea/globo de diálogo es un bloque).
- "bbox" déjalo en [0,0,0,0] (no se usa para posicionar, el panel es lateral).
- "furigana": para cada kanji añade su lectura en hiragana entre paréntesis justo después.
- "kanji": lista SOLO los kanjis (no hiragana/katakana) que puedan resultar difíciles, con su lectura y significado.
- "translation": traducción natural y breve al español.
- Si un bloque no tiene kanjis, "kanji" será un array vacío.
- No inventes texto: usa exactamente el que recibes. Si el OCR tiene errores evidentes, corrígelos con criterio.`

    const raw = await callLiteLLM(llmModel, [{ role: 'user', content: system + '\n\nTexto OCR:\n' + ocrText }], { maxTokens: 4096, temperature: 0.1 })

    const jsonMatch = raw.match(/\{[\s\S]*\}/)
    if (!jsonMatch) throw new Error(`${llmModel} no devolvió JSON válido: ${raw.slice(0, 300)}`)
    return JSON.parse(jsonMatch[0])
  }

  /**
   * Procesa un párrafo de texto (EPUB) directamente con DeepSeek, SIN OCR.
   * El texto ya viene como string (el EPUB tiene el texto real incrustado).
   * Devuelve { original, furigana, translation, kanji }.
   */
  async function runDeepSeekText(text) {
    const system = `Eres un asistente experto en japonés. Recibes un párrafo de texto en japonés (de un libro/novela ligera).

Debes responder SOLO con JSON válido, sin markdown ni comentarios, con esta estructura:
{
  "original": "texto japonés original exacto",
  "furigana": "texto con lectura en furigana: 漢字(かんじ) para cada kanji",
  "translation": "traducción natural y completa al español",
  "kanji": [
    { "kanji": "漢字", "reading": "かんじ", "meaning": "significado en español" }
  ]
}

Reglas:
- "original": copia EXACTA del texto recibido, sin modificar nada.
- "furigana": para cada kanji añade su lectura en hiragana entre paréntesis justo después. Mantén el resto del texto igual.
- "translation": traducción completa, natural y fiel al español (no un resumen).
- "kanji": lista SOLO los kanjis (no hiragana/katakana) que puedan resultar difíciles, con su lectura y significado. Si no hay kanjis, array vacío.
- No inventes texto: usa exactamente el que recibes. Si hay errores evidentes, corrígelos con criterio.`

    const raw = await callLiteLLM(llmModel, [{ role: 'user', content: system + '\n\nTexto:\n' + text }], { maxTokens: 4096, temperature: 0.1 })

    const jsonMatch = raw.match(/\{[\s\S]*\}/)
    if (!jsonMatch) throw new Error(`${llmModel} no devolvió JSON válido: ${raw.slice(0, 300)}`)
    const result = JSON.parse(jsonMatch[0])
    if (!result.original) result.original = text
    return result
  }

  /**
   * Pipeline "quality" — qwen3-omni en UN SOLO paso: OCR + furigana + kanjis + traducción.
   * Más lento por página pero de mayor calidad (un solo modelo entiende el contexto completo).
   */
  async function runQwenOnly(imageBase64, mimeType) {
    const resized = await resizeImage(imageBase64, mimeType)
    const system = `Eres un asistente experto en japonés y OCR de manga. Recibes la imagen de una página de manga.

Debes transcribir TODO el texto en orden de lectura (derecha a izquierda, arriba a abajo) y, para cada bloque, añadir furigana, traducción al español y los kanjis difíciles.

Responde SOLO con JSON válido, sin markdown ni comentarios, con esta estructura:
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
- No inventes texto: usa exactamente el que recibes. Si el OCR tiene errores evidentes, corrígelos con criterio.`

    const content = [
      { type: 'text', text: system },
      { type: 'image_url', image_url: { url: `data:${resized.mimeType};base64,${resized.base64}` } },
    ]
    const raw = await callLiteLLM(ocrModel, [{ role: 'user', content }], { maxTokens: 4096, temperature: 0.1 })

    const jsonMatch = raw.match(/\{[\s\S]*\}/)
    if (!jsonMatch) throw new Error(`${ocrModel} no devolvió JSON válido: ${raw.slice(0, 300)}`)
    const result = JSON.parse(jsonMatch[0])

    const invX = 1 / (resized.scaleX || 1)
    const invY = 1 / (resized.scaleY || 1)
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
   * Analiza una página completa y devuelve el resultado.
   * `type` selecciona el pipeline:
   *   - 'fast'   (por defecto): OCR qwen3-omni → estructuración deepseek-v4-flash (2 pasos, rápido)
   *   - 'quality': qwen3-omni en un solo paso (OCR + furigana + kanjis + traducción)
   * Escala los bbox de vuelta a las coordenadas de la imagen original.
   */
  async function analyzePage(imageBase64, mimeType, type = 'fast') {
    const t1 = Date.now()
    let result
    if (type === 'quality') {
      result = await runQwenOnly(imageBase64, mimeType)
      console.log(`[annotations] qwen-only done in ${Date.now() - t1}ms, blocks=${(result.blocks || []).length}`)
      return result
    }
    const { ocrText, scaleX, scaleY } = await runOcr(imageBase64, mimeType)
    const t2 = Date.now()
    console.log(`[annotations] OCR done in ${t2 - t1}ms`)
    result = await runDeepSeek(ocrText)
    const t3 = Date.now()
    console.log(`[annotations] DeepSeek done in ${t3 - t2}ms, blocks=${(result.blocks || []).length}`)
    if (!result.blocks || result.blocks.length === 0) {
      console.warn('[annotations] WARNING: deepseek devolvió 0 bloques')
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
  async function getOrAnalyze(bookId, pageNumber, imageBase64, mimeType, type = 'fast') {
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
    const result = await analyzePage(imageBase64, mimeType, type)

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

  // ---------------------------------------------------------------------------
  // Jobs de traducción (traducir todo el manga)
  // NOTA: estas rutas deben definirse ANTES de /api/annotations/:bookId/:pageNumber
  // para que Express no las capture como bookId='jobs'.
  // ---------------------------------------------------------------------------

  /**
   * Procesa un job de traducción en background: recorre las páginas del rango y
   * las analiza con el pipeline indicado, actualizando el progreso en SQLite.
   *
   * El job NO recibe las imágenes (el frontend las orquesta): el frontend va
   * enviando cada página vía POST /api/annotations (que ya cachea en el store),
   * y el job solo hace seguimiento del progreso. Esto evita que el backend tenga
   * que descargar las imágenes del libro (no conoce la URL del servidor Komga).
   */
  function startTranslationJob(jobId) {
    // El progreso real lo reporta el frontend al ir traduciendo cada página.
    // Este worker solo marca el job como 'running' y queda a la espera de que el
    // frontend vaya actualizando done_pages vía PATCH /api/annotations/jobs/:id.
    const row = stmtJobGet.get(jobId)
    if (!row) return
    stmtJobUpdate.run(row.done_pages, row.failed_pages, 'running', Date.now(), jobId)
  }

  // POST /api/annotations/jobs — crea un job de traducción
  app.post('/api/annotations/jobs', (req, res) => {
    const { bookId, type, startPage, endPage } = req.body
    if (bookId == null || startPage == null || endPage == null) {
      return res.status(400).json({ error: 'Missing bookId/startPage/endPage' })
    }
    if (type !== 'fast' && type !== 'quality') {
      return res.status(400).json({ error: 'type must be "fast" or "quality"' })
    }
    if (endPage < startPage) {
      return res.status(400).json({ error: 'endPage must be >= startPage' })
    }
    const jobId = crypto.randomUUID()
    const now = Date.now()
    const total = endPage - startPage + 1
    stmtJobInsert.run(jobId, String(bookId), type, startPage, endPage, total, now, now)
    startTranslationJob(jobId)
    res.status(201).json(stmtJobGet.get(jobId))
  })

  // GET /api/annotations/jobs/:id — estado de un job
  app.get('/api/annotations/jobs/:id', (req, res) => {
    const row = stmtJobGet.get(req.params.id)
    if (!row) return res.status(404).json({ error: 'Job not found' })
    res.json(row)
  })

  // PATCH /api/annotations/jobs/:id — actualiza el progreso de un job
  // body: { donePages?, failedPages?, status? }
  app.patch('/api/annotations/jobs/:id', (req, res) => {
    const row = stmtJobGet.get(req.params.id)
    if (!row) return res.status(404).json({ error: 'Job not found' })
    const { donePages, failedPages, status } = req.body
    const newDone = donePages != null ? Number(donePages) : row.done_pages
    const newFailed = failedPages != null ? Number(failedPages) : row.failed_pages
    const newStatus = status || row.status
    stmtJobUpdate.run(newDone, newFailed, newStatus, Date.now(), row.id)
    res.json(stmtJobGet.get(row.id))
  })

  // GET /api/annotations/jobs?bookId=... — lista jobs de un libro
  app.get('/api/annotations/jobs', (req, res) => {
    const { bookId } = req.query
    if (!bookId) return res.status(400).json({ error: 'Missing bookId query param' })
    const rows = stmtJobList.all(String(bookId))
    res.json({ bookId: String(bookId), jobs: rows })
  })

  // GET /api/annotations/:bookId/status — páginas ya traducidas de un libro
  app.get('/api/annotations/:bookId/status', (req, res) => {
    const { bookId } = req.params
    const rows = stmtPages.all(String(bookId))
    res.json({ bookId: String(bookId), pages: rows.map((r) => r.page_number) })
  })

  // ---------------------------------------------------------------------------
  // Anotaciones de texto (EPUB) — furigana + traducción por párrafo, sin OCR
  // ---------------------------------------------------------------------------

  // GET /api/annotations/text/:bookId/:chapter/:paragraph — consulta el store
  app.get('/api/annotations/text/:bookId/:chapter/:paragraph', (req, res) => {
    const { bookId, chapter, paragraph } = req.params
    const stored = getTextStored(bookId, chapter, paragraph)
    if (!stored) return res.status(404).json({ error: 'Not cached' })
    res.json(stored)
  })

  // POST /api/annotations/text — procesa un párrafo con DeepSeek (o devuelve del store)
  app.post('/api/annotations/text', async (req, res) => {
    const { bookId, chapter, paragraph, text } = req.body
    if (!text || !text.trim()) return res.status(400).json({ error: 'Missing "text" in body' })
    if (bookId == null || chapter == null || paragraph == null) {
      return res.status(400).json({ error: 'Missing "bookId"/"chapter"/"paragraph" in body' })
    }
    // 1) Store persistente
    const stored = getTextStored(bookId, chapter, paragraph)
    if (stored) {
      console.log(`[annotations] TEXT STORE HIT book=${bookId} ch=${chapter} p=${paragraph}`)
      return res.json(stored)
    }
    // 2) Análisis con DeepSeek
    try {
      const result = await runDeepSeekText(text)
      storeTextResult(bookId, chapter, paragraph, result)
      console.log(`[annotations] TEXT done book=${bookId} ch=${chapter} p=${paragraph}`)
      res.json(result)
    } catch (err) {
      console.error('[annotations] TEXT error:', err.message)
      res.status(500).json({ error: err.message })
    }
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
    const { bookId, pageNumber, image, mimeType, type } = req.body
    if (!image) return res.status(400).json({ error: 'Missing "image" (base64) in body' })
    if (bookId == null || pageNumber == null) {
      return res.status(400).json({ error: 'Missing "bookId" or "pageNumber" in body' })
    }
    const pipelineType = type === 'quality' ? 'quality' : 'fast'
    try {
      const { result } = await getOrAnalyze(bookId, pageNumber, image, mimeType, pipelineType)
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
