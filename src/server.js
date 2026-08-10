/**
 * Komga Annotations Service
 *
 * Pipeline: imagen de página → Unlimited-OCR (texto + bbox) → DeepSeek V4 Flash (furigana + kanjis)
 *
 * Este servicio vive en el backend y protege la API key de LiteLLM:
 * el cliente (next-ui) NUNCA ve la key, solo llama a este servicio.
 *
 * Endpoints:
 *   POST /api/annotations   body: { image: <base64>, mimeType?: string }
 *       → { blocks: [{ bbox, original, furigana, translation, kanji: [{kanji, reading, meaning}] }] }
 *   GET  /health
 */
import express from 'express'
import cors from 'cors'

const app = express()
app.use(cors())
app.use(express.json({ limit: '25mb' }))

const LITELLM_URL = process.env.LITELLM_URL || 'https://ollama.khlloreda.com'
const LITELLM_API_KEY = process.env.LITELLM_API_KEY || 'sk-litellm-8d13346fba6cd9a78eee874cb8ef4e88bf6c4921'
const OCR_MODEL = process.env.OCR_MODEL || 'unlimited-ocr'
const LLM_MODEL = process.env.LLM_MODEL || 'deepseek-v4-flash'

const PORT = process.env.PORT || 8787

async function callLiteLLM(model, messages, { maxTokens = 4096, temperature = 0.1 } = {}) {
  const res = await fetch(`${LITELLM_URL}/v1/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${LITELLM_API_KEY}`,
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

/**
 * Paso 1: OCR con Unlimited-OCR.
 * Devuelve texto japonés con coordenadas bbox en formato:
 *   <|det|>text [x1,y1,x2,y2]<|/det|>texto
 */
async function runOcr(imageBase64, mimeType) {
  const content = [
    { type: 'text', text: 'Extract all text from the image with bounding boxes.' },
    { type: 'image_url', image_url: { url: `data:${mimeType || 'image/png'};base64,${imageBase64}` } },
  ]
  return callLiteLLM(OCR_MODEL, [{ role: 'user', content }], { maxTokens: 4096, temperature: 0 })
}

/**
 * Paso 2: DeepSeek V4 Flash convierte el OCR en JSON estructurado con furigana y kanjis.
 */
async function runDeepSeek(ocrText) {
  const system = `Eres un asistente experto en japonés. Recibes el texto OCR de una página de manga con coordenadas bbox en formato <|det|>text [x1,y1,x2,y2]<|/det|>.

Debes responder SOLO con JSON válido, sin markdown ni comentarios, con esta estructura:
{
  "blocks": [
    {
      "bbox": [x1, y1, x2, y2],
      "original": "texto japonés original",
      "furigana": "texto con lectura en furigana: 漢字(かんじ) para cada kanji",
      "translation": "traducción breve al español",
      "kanji": [
        { "kanji": "漢字", "reading": "かんじ", "meaning": "significado en español" }
      ]
    }
  ]
}

Reglas:
- Mantén las coordenadas bbox exactas que recibes de cada bloque.
- "furigana": para cada kanji añade su lectura en hiragana entre paréntesis justo después.
- "kanji": lista SOLO los kanjis (no hiragana/katakana) que puedan resultar difíciles, con su lectura y significado.
- "translation": traducción natural y breve al español.
- Si un bloque no tiene kanjis, "kanji" será un array vacío.
- No inventes bloques: usa exactamente los que vienen del OCR.`

  const user = `Texto OCR de la página:\n\n${ocrText}`
  const raw = await callLiteLLM(LLM_MODEL, [
    { role: 'system', content: system },
    { role: 'user', content: user },
  ], { maxTokens: 4096, temperature: 0.1 })

  // Extraer el JSON (por si el modelo envuelve en markdown)
  const jsonMatch = raw.match(/\{[\s\S]*\}/)
  if (!jsonMatch) throw new Error(`DeepSeek no devolvió JSON válido: ${raw.slice(0, 300)}`)
  return JSON.parse(jsonMatch[0])
}

app.get('/health', (_req, res) => {
  res.json({ status: 'ok', ocrModel: OCR_MODEL, llmModel: LLM_MODEL })
})

app.post('/api/annotations', async (req, res) => {
  try {
    const { image, mimeType } = req.body
    if (!image) {
      return res.status(400).json({ error: 'Missing "image" (base64) in body' })
    }

    // Paso 1: OCR
    const ocrText = await runOcr(image, mimeType)

    // Paso 2: DeepSeek → furigana + kanjis
    const result = await runDeepSeek(ocrText)

    res.json(result)
  } catch (err) {
    console.error('[annotations] error:', err.message)
    res.status(500).json({ error: err.message })
  }
})

app.listen(PORT, '0.0.0.0', () => {
  console.log(`[annotations] listening on http://0.0.0.0:${PORT}`)
  console.log(`[annotations] LiteLLM: ${LITELLM_URL} | OCR: ${OCR_MODEL} | LLM: ${LLM_MODEL}`)
})
