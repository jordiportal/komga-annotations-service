/**
 * Komga Annotations Service — punto de arranque
 *
 * Importa createApp() desde app.js (que es testeable) y arranca el servidor.
 * Toda la lógica vive en app.js; este archivo solo configura y escucha.
 */
import path from 'path'
import { createApp } from './app.js'

const PORT = Number(process.env.PORT || 8787)
const DATA_DIR = process.env.DATA_DIR || path.join(process.cwd(), 'data')

const { app } = createApp({
  dbPath: path.join(DATA_DIR, 'annotations.db'),
})

app.listen(PORT, '0.0.0.0', () => {
  console.log(`[annotations] listening on http://0.0.0.0:${PORT}`)
  console.log(`[annotations] LiteLLM: ${process.env.LITELLM_URL || 'https://ollama.khlloreda.com'} | Modelo: ${process.env.OCR_MODEL || 'qwen3-omni'} | PREFETCH_COUNT: ${process.env.PREFETCH_COUNT || 3}`)
})
