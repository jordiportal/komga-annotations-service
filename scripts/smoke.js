#!/usr/bin/env node
/**
 * Smoke test end-to-end del pipeline de anotaciones de Komga.
 *
 * Valida contra los servicios REALES:
 *   1. Servicio de anotaciones (por defecto http://localhost:8787)
 *   2. Proxy de Komga (por defecto http://localhost:25600) — que el endpoint
 *      /api/annotations/... exista y propague el status correcto.
 *
 * Uso:
 *   node scripts/smoke.js
 *   ANNOTATIONS_URL=http://localhost:8787 KOMGA_URL=http://localhost:25600 node scripts/smoke.js
 *
 * Nota: el bloque del proxy de Komga requiere una sesión válida del navegador
 * (cookie). Si devuelve 401, se informa como "requiere sesión" sin fallar.
 *
 * Salida: exit code 0 si todo OK, 1 si algo falla.
 */
import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ANNOTATIONS_URL = process.env.ANNOTATIONS_URL || 'http://localhost:8787'
const KOMGA_URL = process.env.KOMGA_URL || 'http://localhost:25600'
// Imagen real de manga para el smoke (si no existe, se usa el PNG 1x1)
const SAMPLE_IMG = process.env.SAMPLE_IMG || path.join(__dirname, '..', '..', '..', 'ocr_test', 'manga', 'sample_manga.png')

let failures = 0
let warnings = 0
function check(name, cond, extra = '') {
  const ok = Boolean(cond)
  console.log(`${ok ? '  ✅' : '  ❌'} ${name}${extra ? ` — ${extra}` : ''}`)
  if (!ok) failures++
}
function warn(name, extra = '') {
  warnings++
  console.log(`  ⚠️  ${name}${extra ? ` — ${extra}` : ''}`)
}

// Cargar imagen de prueba (real de manga si existe, si no PNG 1x1)
function loadSampleImage() {
  if (fs.existsSync(SAMPLE_IMG)) {
    const buf = fs.readFileSync(SAMPLE_IMG)
    return { base64: buf.toString('base64'), mimeType: 'image/png', label: path.basename(SAMPLE_IMG) }
  }
  const PNG_1x1 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M8AAAMBAQDJ/pLvAAAAAElFTkSuQmCC'
  return { base64: PNG_1x1, mimeType: 'image/png', label: 'PNG 1x1 (placeholder)' }
}

// ---------------------------------------------------------------------------
// 1) Servicio de anotaciones
// ---------------------------------------------------------------------------
async function testAnnotationsService() {
  console.log(`\n[1] Servicio de anotaciones (${ANNOTATIONS_URL})`)
  const sample = loadSampleImage()
  console.log(`    Imagen de prueba: ${sample.label}`)

  // health
  const health = await fetch(`${ANNOTATIONS_URL}/health`).then((r) => r.json())
  check('GET /health responde ok', health.status === 'ok', `ocr=${health.ocrModel} llm=${health.llmModel} stored=${health.stored}`)

  // POST analiza una página (bookId único para no chocar con datos reales)
  const bookId = `smoke-${Date.now()}`
  const post = await fetch(`${ANNOTATIONS_URL}/api/annotations`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ bookId, pageNumber: 1, image: sample.base64, mimeType: sample.mimeType }),
  })
  check('POST /api/annotations responde 200', post.status === 200, `status=${post.status}`)
  const postBody = await post.json()
  check('POST devuelve blocks[]', Array.isArray(postBody.blocks) && postBody.blocks.length > 0,
    `blocks=${Array.isArray(postBody.blocks) ? postBody.blocks.length : 'N/A'}`)

  // GET del store
  const get = await fetch(`${ANNOTATIONS_URL}/api/annotations/${bookId}/1`)
  check('GET /api/annotations/:bookId/:pageNumber responde 200', get.status === 200)
  const getBody = await get.json()
  check('GET devuelve el mismo resultado', JSON.stringify(getBody) === JSON.stringify(postBody))

  // GET 404
  const miss = await fetch(`${ANNOTATIONS_URL}/api/annotations/${bookId}/9999`)
  check('GET de página inexistente responde 404', miss.status === 404, `status=${miss.status}`)

  // status
  const status = await fetch(`${ANNOTATIONS_URL}/api/annotations/${bookId}/status`).then((r) => r.json())
  check('GET /status lista la página traducida', Array.isArray(status.pages) && status.pages.includes(1))

  // prefetch
  const prefetch = await fetch(`${ANNOTATIONS_URL}/api/annotations/prefetch`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ bookId, pageNumber: 2, image: sample.base64, mimeType: sample.mimeType }),
  })
  check('POST /prefetch responde 202', prefetch.status === 202, `status=${prefetch.status}`)
  // esperar a que termine en background
  await new Promise((r) => setTimeout(r, 1500))
  const prefetched = await fetch(`${ANNOTATIONS_URL}/api/annotations/${bookId}/2`)
  check('Página prefetched quedó en el store', prefetched.status === 200)
}

// ---------------------------------------------------------------------------
// 2) Proxy de Komga
// ---------------------------------------------------------------------------
async function testKomgaProxy() {
  console.log(`\n[2] Proxy de Komga (${KOMGA_URL})`)

  // health del servicio a través de Komga
  const healthRes = await fetch(`${KOMGA_URL}/api/annotations/health`)
  if (healthRes.status === 401) {
    warn('Proxy requiere sesión (401) — valida con cookie del navegador', 'no es un fallo del servicio')
    return
  }
  const health = await healthRes.json()
  check('Proxy /health responde', health.status === 'ok', JSON.stringify(health))

  // El proxy debe propagar el 404 del store (bug corregido)
  const miss = await fetch(`${KOMGA_URL}/api/annotations/nonexistent-book/9999`)
  check('Proxy propaga 404 de página inexistente', miss.status === 404, `status=${miss.status}`)
}

// ---------------------------------------------------------------------------
async function main() {
  try {
    await testAnnotationsService()
  } catch (e) {
    failures++
    console.log(`  ❌ Servicio de anotaciones falló: ${e.message}`)
  }

  try {
    await testKomgaProxy()
  } catch (e) {
    failures++
    console.log(`  ❌ Proxy de Komga falló: ${e.message}`)
  }

  console.log(`\n${failures === 0 ? '✅ SMOKE TEST OK' : `❌ ${failures} comprobaciones fallaron`}${warnings ? ` (${warnings} avisos)` : ''}`)
  process.exit(failures === 0 ? 0 : 1)
}

main()
