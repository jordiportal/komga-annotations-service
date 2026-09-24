/**
 * Komga Annotations Service — aplicación Express (testeable)
 *
 * Pipeline (1 paso):
 *   deepseek-v4-flash (con visión): OCR + furigana + kanjis + traducción en una sola llamada.
 *
 * Este módulo expone `createApp()` con dependencias inyectables para poder testear
 * el servicio sin arrancar un servidor real ni llamar a la API de LiteLLM.
 *
 * `server.js` es el punto de arranque: importa createApp() y hace app.listen().
 *
 * Endpoints:
 *   POST /api/annotations            body: { bookId, pageNumber, image, mimeType, type }
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
    liteLLMUrl = process.env.LITELLM_URL || 'https://litellm.khlloreda.com',
    liteLLMApiKey = process.env.LITELLM_API_KEY || 'sk-litellm-8d13346fba6cd9a78eee874cb8ef4e88bf6c4921',
    ocrModel = process.env.OCR_MODEL || 'qwen3-omni',
    llmModel = process.env.LLM_MODEL || 'deepseek-v4-flash',
    fallbackModel = process.env.FALLBACK_MODEL || 'kimi-k3',
    prefetchCount = Number(process.env.PREFETCH_COUNT || 3),
    allowedOrigins = (process.env.ALLOWED_ORIGINS || '').split(',').map((s) => s.trim()).filter(Boolean),
    targetLang = process.env.TARGET_LANG || 'es',
  } = opts

  // Idioma de destino de las traducciones. 'es' = castellano, 'ca' = català.
  const TARGET_LANG_NAME = targetLang === 'ca' ? 'català' : 'castellano'
  const TARGET_LANG_EXTRA = targetLang === 'ca'
    ? 'Traduce SIEMPRE al català (lengua catalana), nunca a otro idioma.'
    : 'Traduce SIEMPRE al castellano (español), nunca a otro idioma.'
  const TARGET_LANG_BAN = 'Está TERMINANTEMENTE PROHIBIDO traducir al chino, japonés, inglés o cualquier otro idioma distinto del idioma objetivo. Si el texto ya está en el idioma objetivo, tradúcelo igualmente de forma natural.'

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
  const stmtTextCount = db.prepare('SELECT COUNT(*) AS n FROM text_annotations WHERE book_id = ?')

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
  async function defaultCallLiteLLM(model, messages, { maxTokens = 4096, temperature = 0.1, reasoningEffort } = {}) {
    const body = {
      model,
      messages,
      max_tokens: maxTokens,
      temperature,
    }
    // Desactivar el razonamiento del modelo (deepseek-v4-flash es un modelo de
    // razonamiento: consume muchos tokens en reasoning_content antes de generar el
    // content final, lo que hace que el proxy openresty corte con 504). Con
    // reasoning_effort='none' la respuesta es ~6x más rápida y el content llega completo.
    if (reasoningEffort) body.reasoning_effort = reasoningEffort
    const res = await fetch(`${liteLLMUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${liteLLMApiKey}`,
      },
      body: JSON.stringify(body),
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
   * Redimensiona y comprime la imagen base64 a un tamaño manejable para el OCR/traducción.
   * Limita la carga al LLM: resolución moderada (maxDim) + compresión WebP (quality).
   *
   * Usa WebP en lugar de JPEG porque el line art de manga (colores planos, bordes
   * nítidos) comprime MUCHO mejor en WebP que en JPEG (verificado: un PNG de 37KB
   * pasa a 116KB en JPEG q85 pero a 66KB en WebP q80; en fotos WebP es ~3x más
   * pequeño). DeepSeek v4 Flash (vía LiteLLM) acepta WebP como image_url.
   *
   * IMPORTANTE: las páginas normales de manga ya vienen MUY bien comprimidas en
   * PNG (line art con paleta, ~35KB). Re-encodearlas a RGB+WebP las AGRANDA
   * (verificado: 37KB -> 66KB). Por eso, tras comprimir, se compara el tamaño del
   * resultado con el original y se envía SIEMPRE el más pequeño. Así nunca se
   * manda más carga que la original, pero las imágenes grandes (portadas, páginas
   * a color) sí se comprimen masivamente (3.4MB -> 67KB).
   *
   * Devuelve { base64, mimeType, width, height, scaleX, scaleY }.
   *
   * Configurable por env:
   *   - IMAGE_MAX_DIM  (px, lado mayor, por defecto 1000)
   *   - IMAGE_QUALITY  (0-100, por defecto 80)
   */
  async function resizeImage(imageBase64, mimeType) {
    const maxDim = Number(process.env.IMAGE_MAX_DIM || 1000)
    const quality = Number(process.env.IMAGE_QUALITY || 80)
    try {
      // Carga dinámica de sharp: si el binario nativo no está disponible,
      // devolvemos la imagen SIN redimensionar. Esto es un riesgo (se envía la
      // imagen original al LLM), así que lo logueamos para poder detectarlo.
      let sharp
      try {
        sharp = (await import('sharp')).default
      } catch {
        console.warn(`[annotations] WARNING: sharp no disponible, se envía la imagen ORIGINAL sin comprimir (mime=${mimeType || 'image/png'})`)
        return { base64: imageBase64, mimeType: mimeType || 'image/png', width: 0, height: 0, scaleX: 1, scaleY: 1 }
      }
      const buf = Buffer.from(imageBase64, 'base64')
      const img = sharp(buf)
      const meta = await img.metadata()
      let width = meta.width
      let height = meta.height
      let scaleX = 1
      let scaleY = 1
      // Solo redimensionar si supera el lado mayor permitido
      if (width > maxDim || height > maxDim) {
        const scale = Math.min(maxDim / width, maxDim / height)
        scaleX = scale
        scaleY = scale
        width = Math.round(width * scale)
        height = Math.round(height * scale)
      }
      // Comprimir a WebP (incluso si no se redimensiona).
      const outBuf = await img.resize(width, height).webp({ quality }).toBuffer()
      const origKB = (buf.length / 1024).toFixed(1)
      const outKB = (outBuf.length / 1024).toFixed(1)

      // Elegir SIEMPRE el más pequeño entre el original y el comprimido.
      // Las páginas normales de manga (PNG con paleta) ya están muy comprimidas:
      // re-encodearlas a WebP las agranda, así que en ese caso se envía el original.
      if (outBuf.length < buf.length) {
        console.log(`[annotations] resizeImage ${meta.width}x${meta.height} -> ${width}x${height} (${origKB}KB -> ${outKB}KB, webp q=${quality})`)
        return {
          base64: outBuf.toString('base64'),
          mimeType: 'image/webp',
          width,
          height,
          scaleX,
          scaleY,
        }
      }
      // El original es más pequeño (o igual): enviarlo tal cual, sin re-encodear.
      console.log(`[annotations] resizeImage ${meta.width}x${meta.height} -> original más pequeño (${origKB}KB vs ${outKB}KB webp), se envía el original`)
      return {
        base64: imageBase64,
        mimeType: mimeType || 'image/png',
        width: meta.width,
        height: meta.height,
        scaleX: 1,
        scaleY: 1,
      }
    } catch (e) {
      console.warn(`[annotations] WARNING: resizeImage falló (${e.message}), se envía la imagen ORIGINAL sin comprimir`)
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
   * furigana + kanjis + traducción al idioma objetivo. Devuelve el JSON estructurado.
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
      "translation": "traducción breve al ${TARGET_LANG_NAME}",
      "kanji": [
        { "kanji": "漢字", "reading": "かんじ", "meaning": "significado en ${TARGET_LANG_NAME}" }
      ]
    }
  ]
}

Reglas:
- Divide el texto en bloques lógicos (cada línea/globo de diálogo es un bloque).
- "bbox" déjalo en [0,0,0,0] (no se usa para posicionar, el panel es lateral).
- "furigana": para cada kanji añade su lectura en hiragana entre paréntesis justo después.
- "kanji": lista SOLO los kanjis (no hiragana/katakana) que puedan resultar difíciles, con su lectura y significado (en ${TARGET_LANG_NAME}).
- "translation": traducción natural y breve al ${TARGET_LANG_NAME}. ${TARGET_LANG_EXTRA} ${TARGET_LANG_BAN}
- Si un bloque no tiene kanjis, "kanji" será un array vacío.
- No inventes texto: usa exactamente el que recibes. Si el OCR tiene errores evidentes, corrígelos con criterio.`

    const raw = await callLiteLLM(llmModel, [{ role: 'user', content: system + '\n\nTexto OCR:\n' + ocrText }], { maxTokens: 4096, temperature: 0.1, reasoningEffort: 'none' })

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
    // Las comillas japonesas 「」/『』 se reemplazan por comillas normales antes de enviar
    // (y se restaura el original al final). El prompt es CORTO y directo: un prompt largo
    // con muchas menciones a "chino/hanzi/kanji" confunde al modelo y dispara la
    // traducción al chino (verificado con prueba A/B: el mismo modelo traduce bien
    // al español con un prompt limpio).
    const cleanText = text.replace(/[「」『』]/g, '"')
    const system = `Eres un traductor profesional de japonés a ${TARGET_LANG_NAME}. Recibes un párrafo de una novela ligera japonesa.

Responde SOLO con JSON válido, sin markdown ni comentarios, con esta estructura exacta:
{
  "original": "el texto japonés exacto que recibes",
  "furigana": "el mismo texto pero con la lectura en hiragana de cada kanji entre paréntesis, ej: 魔物(まもの)",
  "translation": "traducción completa, natural y fiel al ${TARGET_LANG_NAME}",
  "kanji": [
    { "kanji": "un kanji del texto", "reading": "su lectura en hiragana", "meaning": "su significado en ${TARGET_LANG_NAME}" }
  ]
}

Reglas:
- "original": copia exacta del texto recibido.
- "furigana": añade la lectura en hiragana entre paréntesis tras cada kanji, manteniendo el resto igual.
- "translation": traduce TODO el texto al ${TARGET_LANG_NAME} de forma natural y completa (no un resumen).
- "kanji": lista los kanjis difíciles con su lectura y significado en ${TARGET_LANG_NAME}. Si no hay, array vacío.
- No inventes texto: usa exactamente el que recibes.`

    // Reintentos: el primer intento usa el modelo principal (llmModel).
    // Si falla (JSON inválido o traducción en chino/japonés), los reintentos
    // pasan al modelo de respaldo (fallbackModel, p.ej. kimi-k3), que no tiene
    // el sesgo hacia el chino de deepseek. Repetir el mismo modelo no sirve
    // (falla igual), así que no lo repetimos.
    let lastErr = null
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const model = attempt === 0 ? llmModel : fallbackModel
        let instruction = ''
        if (attempt > 0) {
          instruction = `\n\nIMPORTANTE: El intento anterior FALLÓ por este motivo: "${String(lastErr && lastErr.message || '').slice(0, 200)}".\n` +
            `Corrige el error. Si el motivo es que la traducción salió en chino/japonés, vuelve a traducirla AHORA al ${TARGET_LANG_NAME} correctamente. ` +
            `Si el motivo es que el JSON estaba truncado/incompleto, responde el JSON COMPLETO y CERRADO con su llave final.`
        }
        const raw = await callLiteLLM(model, [{ role: 'user', content: system + '\n\nTexto:\n' + cleanText + instruction }], { maxTokens: 8192, temperature: 0.1, reasoningEffort: 'none' })
        const jsonMatch = raw.match(/\{[\s\S]*\}/)
        if (!jsonMatch) throw new Error(`${model} no devolvió JSON válido: ${raw.slice(0, 300)}`)
        const result = JSON.parse(jsonMatch[0])
        // Restaurar las comillas japonesas originales en el campo "original"
        result.original = text
        // Validar que la traducción NO esté en chino/japonés
        validateTranslationLang(result)
        return result
      } catch (e) {
        lastErr = e
        if (attempt < 2) {
          console.warn(`[annotations] TEXT reintento ${attempt + 1} (${attempt === 0 ? llmModel : fallbackModel}) tras: ${e.message.slice(0, 120)}`)
        }
      }
    }
    throw lastErr
  }


  /**
   * Detecta si un texto contiene caracteres CJK (chino/japonés).
   * Devuelve true si hay caracteres Han (kanji/hanzi) o kana.
   */
  function containsCJK(text) {
    if (!text) return false
    // Kana (hiragana/katakana) = japonés inequívoco
    if (/[\u3040-\u30FF]/.test(text)) return true
    // Han (kanji/hanzi): solo se considera CJK si es una proporción alta del texto.
    // Un kanji suelto en un párrafo castellano (nombre propio, carácter residual)
    // NO es chino/japonés y no debe rechazarse.
    const han = (text.match(/[\u4E00-\u9FFF\u3400-\u4DBF]/g) || []).length
    const total = text.replace(/\s/g, '').length
    return total > 0 && (han / total) > 0.30
  }

  /**
   * Valida que la traducción esté en el idioma objetivo (no chino/japonés).
   * Si la traducción contiene caracteres CJK, lanza un error para reintentar.
   */
  function validateTranslationLang(result) {
    const translation = (result && result.translation) || ''
    const meaning = (result && result.kanji && Array.isArray(result.kanji))
      ? result.kanji.map(k => (k && k.meaning) || '').join(' ')
      : ''
    if (containsCJK(translation) || containsCJK(meaning)) {
      throw new Error(`traducción en idioma no objetivo (contiene CJK): ${translation.slice(0, 80)}`)
    }
    return result
  }

  /**
   * Pipeline "quality" — qwen3-omni en UN SOLO paso: OCR + furigana + kanjis + traducción.
   * Más lento por página pero de mayor calidad (un solo modelo entiende el contexto completo).
   */
  async function runQwenOnly(imageBase64, mimeType) {
    const resized = await resizeImage(imageBase64, mimeType)
    const system = `Eres un asistente experto en japonés y OCR de manga. Recibes la imagen de una página de manga.

Debes transcribir TODO el texto en orden de lectura (derecha a izquierda, arriba a abajo) y, para cada bloque, añadir furigana, traducción al ${TARGET_LANG_NAME} y los kanjis difíciles.

Responde SOLO con JSON válido, sin markdown ni comentarios, con esta estructura:
{
  "blocks": [
    {
      "bbox": [0, 0, 0, 0],
      "original": "texto japonés original (un párrafo o globo de diálogo)",
      "furigana": "texto con lectura en furigana: 漢字(かんじ) para cada kanji",
      "translation": "traducción breve al ${TARGET_LANG_NAME}",
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
- "kanji": lista SOLO los kanjis (no hiragana/katakana) que puedan resultar difíciles, con su lectura y significado (en ${TARGET_LANG_NAME}).
- "translation": traducción natural y breve al ${TARGET_LANG_NAME}. ${TARGET_LANG_EXTRA} ${TARGET_LANG_BAN}
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
   * Pipeline de UN SOLO PASO con deepseek-v4-flash (que ya soporta visión):
   * recibe la imagen directamente y hace OCR + furigana + kanjis + traducción.
   * Reemplaza al pipeline de 2 pasos (runOcr + runDeepSeek) que ya no hace falta.
   *
   * El prompt es CORTO y limpio (igual que runDeepSeekText): un prompt largo con
   * muchas menciones a "chino/hanzi/kanji" confunde a deepseek y dispara la
   * traducción al chino (verificado con prueba A/B en el knowledge del proyecto).
   */
  async function runDeepSeekVision(imageBase64, mimeType) {
    const resized = await resizeImage(imageBase64, mimeType)
    const system = `Eres un traductor profesional de japonés a ${TARGET_LANG_NAME}. Recibes la imagen de una página de manga.

Transcribe TODO el texto en orden de lectura (derecha a izquierda, arriba a abajo) y, para cada globo de diálogo o párrafo coherente, añade furigana, traducción y los kanjis difíciles.

Responde SOLO con JSON válido, sin markdown ni comentarios, con esta estructura exacta:
{
  "blocks": [
    {
      "bbox": [0, 0, 0, 0],
      "original": "texto japonés original (un párrafo o globo de diálogo)",
      "furigana": "el mismo texto pero con la lectura en hiragana de cada kanji entre paréntesis, ej: 魔物(まもの)",
      "translation": "traducción completa, natural y fiel al ${TARGET_LANG_NAME}",
      "kanji": [
        { "kanji": "un kanji del texto", "reading": "su lectura en hiragana", "meaning": "su significado en ${TARGET_LANG_NAME}" }
      ]
    }
  ]
}

Reglas:
- Divide el texto en bloques lógicos (cada globo de diálogo o párrafo coherente es un bloque).
- "bbox" déjalo en [0,0,0,0] (no se usa para posicionar, el panel es lateral).
- "furigana": añade la lectura en hiragana entre paréntesis tras cada kanji, manteniendo el resto igual.
- "translation": traduce TODO el texto al ${TARGET_LANG_NAME} de forma natural y completa (no un resumen). ${TARGET_LANG_EXTRA} ${TARGET_LANG_BAN}
- "kanji": lista los kanjis difíciles con su lectura y significado en ${TARGET_LANG_NAME}. Si no hay, array vacío.
- No inventes texto: usa exactamente el que aparece en la imagen. Si el OCR tiene errores evidentes, corrígelos con criterio.`

    const content = [
      { type: 'text', text: system },
      { type: 'image_url', image_url: { url: `data:${resized.mimeType};base64,${resized.base64}` } },
    ]
    const raw = await callLiteLLM(llmModel, [{ role: 'user', content }], { maxTokens: 8192, temperature: 0.1, reasoningEffort: 'none' })

    const jsonMatch = raw.match(/\{[\s\S]*\}/)
    if (!jsonMatch) throw new Error(`${llmModel} no devolvió JSON válido: ${raw.slice(0, 300)}`)
    const result = JSON.parse(jsonMatch[0])

    // Validar que NINGUNA traducción esté en chino/japonés (red de seguridad)
    for (const block of (result.blocks || [])) {
      validateTranslationLang(block)
    }

    // Escalar los bbox de vuelta a las coordenadas de la imagen original
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
   *   - 'fast'   (por defecto): deepseek-v4-flash en UN SOLO paso (OCR + furigana + kanjis + traducción)
   *   - 'quality': qwen3-omni en un solo paso (OCR + furigana + kanjis + traducción)
   *   - 'legacy' : 2 pasos (OCR qwen3-omni → estructuración deepseek-v4-flash) — solo por compatibilidad
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
    if (type === 'legacy') {
      // Pipeline antiguo de 2 pasos (OCR qwen3-omni → estructuración deepseek-v4-flash).
      // Solo se mantiene por compatibilidad; 'fast' ya no lo usa.
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
    // 'fast' (por defecto): deepseek-v4-flash en UN SOLO paso (visión)
    result = await runDeepSeekVision(imageBase64, mimeType)
    const t2 = Date.now()
    console.log(`[annotations] deepseek-vision done in ${t2 - t1}ms, blocks=${(result.blocks || []).length}`)
    if (!result.blocks || result.blocks.length === 0) {
      console.warn('[annotations] WARNING: deepseek-vision devolvió 0 bloques')
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
    if (type !== 'fast' && type !== 'quality' && type !== 'legacy') {
      return res.status(400).json({ error: 'type must be "fast", "quality" or "legacy"' })
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

  // GET /api/annotations/text/:bookId/status — número de párrafos traducidos de un libro EPUB
  app.get('/api/annotations/text/:bookId/status', (req, res) => {
    const { bookId } = req.params
    const n = stmtTextCount.get(String(bookId)).n
    res.json({ bookId: String(bookId), translatedParagraphs: n })
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
    const pipelineType = type === 'quality' ? 'quality' : (type === 'legacy' ? 'legacy' : 'fast')
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
