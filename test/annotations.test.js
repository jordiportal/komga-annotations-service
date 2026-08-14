/**
 * Tests del servicio de anotaciones (unit + integración HTTP).
 *
 * Usa node:test (sin dependencias externas) y un servidor HTTP real en puerto
 * efímero, con callLiteLLM mockeado para NO llamar a la API real de LiteLLM.
 *
 * Ejecutar:  npm test   (o: node --test test/)
 */
import { test, before, after, describe } from 'node:test'
import assert from 'node:assert/strict'
import { createApp } from '../src/app.js'

// PNG 1x1 válido (base64) — suficiente para que sharp no falle
const PNG_1x1 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M8AAAMBAQDJ/pLvAAAAAElFTkSuQmCC'
// PNG 1x1 distinto (rojo) — para forzar análisis real en el prefetch (evita cache hit por hash de imagen)
const PNG_1x1_RED = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='

// Resultado JSON que devolverá el "deepseek-v4-flash" mockeado (paso 2: estructuración)
const MOCK_RESULT = {
  blocks: [
    {
      bbox: [0, 0, 0, 0],
      original: 'こんにちは世界',
      furigana: 'こんにちは世界(せかい)',
      translation: 'Hola mundo',
      kanji: [{ kanji: '世界', reading: 'せかい', meaning: 'mundo' }],
    },
  ],
}

function makeMockLiteLLM() {
  const calls = []
  return {
    calls,
    fn: async (model, messages, opts) => {
      calls.push({ model, messages, opts })
      if (model === 'qwen3-omni') {
        // Si la petición incluye una imagen (content con image_url) → modo quality (JSON)
        // Si es solo texto → paso 1 OCR (texto plano)
        const content = messages?.[0]?.content
        const hasImage = Array.isArray(content) && content.some((c) => c.type === 'image_url')
        if (hasImage) {
          return JSON.stringify(MOCK_RESULT)
        }
        // Paso 1 (OCR): devuelve texto plano
        return 'こんにちは世界\n'
      }
      if (model === 'deepseek-v4-flash') {
        // Paso 2 (estructuración): devuelve JSON
        return JSON.stringify(MOCK_RESULT)
      }
      throw new Error(`Unexpected model ${model}`)
    },
  }
}

describe('Komga Annotations Service', () => {
  let server
  let baseUrl
  let mock
  let appCtx

  before(async () => {
    mock = makeMockLiteLLM()
    appCtx = createApp({
      callLiteLLM: mock.fn,
      ocrModel: 'qwen3-omni',
      llmModel: 'deepseek-v4-flash',
    })
    server = appCtx.app.listen(0)
    await new Promise((resolve) => server.once('listening', resolve))
    baseUrl = `http://127.0.0.1:${server.address().port}`
  })

  after(async () => {
    await new Promise((resolve) => server.close(resolve))
    appCtx.db.close()
  })

  test('GET /health devuelve ok y modelos', async () => {
    const res = await fetch(`${baseUrl}/health`)
    assert.equal(res.status, 200)
    const body = await res.json()
    assert.equal(body.status, 'ok')
    assert.equal(body.ocrModel, 'qwen3-omni')
    assert.equal(body.llmModel, 'deepseek-v4-flash')
  })

  test('POST /api/annotations analiza una página y devuelve blocks', async () => {
    const res = await fetch(`${baseUrl}/api/annotations`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ bookId: 'b1', pageNumber: 1, image: PNG_1x1, mimeType: 'image/png' }),
    })
    assert.equal(res.status, 200)
    const body = await res.json()
    assert.ok(Array.isArray(body.blocks))
    assert.equal(body.blocks.length, 1)
    assert.equal(body.blocks[0].furigana, 'こんにちは世界(せかい)')
    // Debe haber llamado a qwen3-omni (OCR) y deepseek-v4-flash (estructuración)
    assert.equal(mock.calls.length, 2)
    assert.equal(mock.calls[0].model, 'qwen3-omni')
    assert.equal(mock.calls[1].model, 'deepseek-v4-flash')
  })

  test('POST /api/annotations con la misma página devuelve del STORE (sin llamar al LLM)', async () => {
    const callsBefore = mock.calls.length
    const res = await fetch(`${baseUrl}/api/annotations`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ bookId: 'b1', pageNumber: 1, image: PNG_1x1, mimeType: 'image/png' }),
    })
    assert.equal(res.status, 200)
    const body = await res.json()
    assert.equal(body.blocks.length, 1)
    // No debe haber nuevas llamadas al LLM (store hit)
    assert.equal(mock.calls.length, callsBefore)
  })

  test('GET /api/annotations/:bookId/:pageNumber devuelve 404 si no está en el store', async () => {
    const res = await fetch(`${baseUrl}/api/annotations/b1/999`)
    assert.equal(res.status, 404)
    const body = await res.json()
    assert.equal(body.error, 'Not cached')
  })

  test('GET /api/annotations/:bookId/:pageNumber devuelve la página del store', async () => {
    const res = await fetch(`${baseUrl}/api/annotations/b1/1`)
    assert.equal(res.status, 200)
    const body = await res.json()
    assert.equal(body.blocks.length, 1)
  })

  test('GET /api/annotations/:bookId/status lista las páginas traducidas', async () => {
    const res = await fetch(`${baseUrl}/api/annotations/b1/status`)
    assert.equal(res.status, 200)
    const body = await res.json()
    assert.equal(body.bookId, 'b1')
    assert.deepEqual(body.pages, [1])
  })

  test('POST /api/annotations/prefetch responde 202 y analiza en background', async () => {
    const callsBefore = mock.calls.length
    const res = await fetch(`${baseUrl}/api/annotations/prefetch`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ bookId: 'b2', pageNumber: 5, image: PNG_1x1_RED, mimeType: 'image/png' }),
    })
    assert.equal(res.status, 202)
    const body = await res.json()
    assert.equal(body.status, 'queued')

    // Esperar a que el background termine (2 llamadas: qwen3-omni + deepseek)
    for (let i = 0; i < 50 && mock.calls.length < callsBefore + 2; i++) {
      await new Promise((r) => setTimeout(r, 50))
    }
    assert.ok(mock.calls.length >= callsBefore + 2, 'el prefetch debería haber llamado al LLM')

    // Ahora la página está en el store
    const storedRes = await fetch(`${baseUrl}/api/annotations/b2/5`)
    assert.equal(storedRes.status, 200)
  })

  test('POST /api/annotations sin imagen devuelve 400', async () => {
    const res = await fetch(`${baseUrl}/api/annotations`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ bookId: 'b1', pageNumber: 2 }),
    })
    assert.equal(res.status, 400)
  })

  test('POST /api/annotations sin bookId/pageNumber devuelve 400', async () => {
    const res = await fetch(`${baseUrl}/api/annotations`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ image: PNG_1x1 }),
    })
    assert.equal(res.status, 400)
  })

  test('el LLM que devuelve JSON inválido produce 500', async () => {
    const badCtx = createApp({
      callLiteLLM: async (model) => (model === 'qwen3-omni' ? 'texto ocr\n' : 'esto no es json'),
      ocrModel: 'qwen3-omni',
      llmModel: 'deepseek-v4-flash',
    })
    const badServer = badCtx.app.listen(0)
    await new Promise((resolve) => badServer.once('listening', resolve))
    const url = `http://127.0.0.1:${badServer.address().port}`
    try {
      const res = await fetch(`${url}/api/annotations`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ bookId: 'x', pageNumber: 1, image: PNG_1x1 }),
      })
      assert.equal(res.status, 500)
    } finally {
      await new Promise((resolve) => badServer.close(resolve))
      badCtx.db.close()
    }
  })

  // ---------------------------------------------------------------------------
  // Jobs de traducción
  // ---------------------------------------------------------------------------

  test('POST /api/annotations/jobs crea un job y lo devuelve', async () => {
    const res = await fetch(`${baseUrl}/api/annotations/jobs`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ bookId: 'b1', type: 'fast', startPage: 1, endPage: 10 }),
    })
    assert.equal(res.status, 201)
    const job = await res.json()
    assert.ok(job.id)
    assert.equal(job.book_id, 'b1')
    assert.equal(job.type, 'fast')
    assert.equal(job.status, 'running')
    assert.equal(job.total_pages, 10)
    assert.equal(job.start_page, 1)
    assert.equal(job.end_page, 10)
  })

  test('POST /api/annotations/jobs valida type', async () => {
    const res = await fetch(`${baseUrl}/api/annotations/jobs`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ bookId: 'b1', type: 'invalid', startPage: 1, endPage: 10 }),
    })
    assert.equal(res.status, 400)
  })

  test('GET /api/annotations/jobs/:id devuelve el estado del job', async () => {
    const createRes = await fetch(`${baseUrl}/api/annotations/jobs`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ bookId: 'b1', type: 'quality', startPage: 1, endPage: 5 }),
    })
    const created = await createRes.json()
    const res = await fetch(`${baseUrl}/api/annotations/jobs/${created.id}`)
    assert.equal(res.status, 200)
    const job = await res.json()
    assert.equal(job.id, created.id)
    assert.equal(job.type, 'quality')
    assert.equal(job.total_pages, 5)
  })

  test('GET /api/annotations/jobs/:id devuelve 404 si no existe', async () => {
    const res = await fetch(`${baseUrl}/api/annotations/jobs/nonexistent`)
    assert.equal(res.status, 404)
  })

  test('PATCH /api/annotations/jobs/:id actualiza el progreso', async () => {
    const createRes = await fetch(`${baseUrl}/api/annotations/jobs`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ bookId: 'b1', type: 'fast', startPage: 1, endPage: 10 }),
    })
    const created = await createRes.json()

    const patchRes = await fetch(`${baseUrl}/api/annotations/jobs/${created.id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ donePages: 4, failedPages: 1 }),
    })
    assert.equal(patchRes.status, 200)
    const job = await patchRes.json()
    assert.equal(job.done_pages, 4)
    assert.equal(job.failed_pages, 1)

    // Completar
    const doneRes = await fetch(`${baseUrl}/api/annotations/jobs/${created.id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ donePages: 10, status: 'completed' }),
    })
    const done = await doneRes.json()
    assert.equal(done.done_pages, 10)
    assert.equal(done.status, 'completed')
  })

  test('GET /api/annotations/jobs?bookId= lista los jobs de un libro', async () => {
    const res = await fetch(`${baseUrl}/api/annotations/jobs?bookId=b1`)
    assert.equal(res.status, 200)
    const body = await res.json()
    assert.equal(body.bookId, 'b1')
    assert.ok(Array.isArray(body.jobs))
    assert.ok(body.jobs.length >= 3)
  })

  test('GET /api/annotations/jobs sin bookId devuelve 400', async () => {
    const res = await fetch(`${baseUrl}/api/annotations/jobs`)
    assert.equal(res.status, 400)
  })

  // ---------------------------------------------------------------------------
  // Pipeline quality (qwen solo)
  // ---------------------------------------------------------------------------

  test('POST /api/annotations con type=quality usa un solo paso (qwen3-omni)', async () => {
    const qMock = makeMockLiteLLM()
    const qCtx = createApp({
      callLiteLLM: qMock.fn,
      ocrModel: 'qwen3-omni',
      llmModel: 'deepseek-v4-flash',
    })
    const qServer = qCtx.app.listen(0)
    await new Promise((resolve) => qServer.once('listening', resolve))
    const url = `http://127.0.0.1:${qServer.address().port}`
    try {
      const res = await fetch(`${url}/api/annotations`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ bookId: 'q1', pageNumber: 1, image: PNG_1x1, mimeType: 'image/png', type: 'quality' }),
      })
      assert.equal(res.status, 200)
      const body = await res.json()
      assert.ok(Array.isArray(body.blocks))
      assert.equal(body.blocks.length, 1)
      // Solo debe llamar a qwen3-omni UNA vez (no a deepseek)
      assert.equal(qMock.calls.length, 1)
      assert.equal(qMock.calls[0].model, 'qwen3-omni')
    } finally {
      await new Promise((resolve) => qServer.close(resolve))
      qCtx.db.close()
    }
  })
})
