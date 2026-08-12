# Testing del servicio de anotaciones

Este servicio tiene dos niveles de validación para que Khai (y cualquier agente)
pueda verificar que los cambios funcionan sin depender de la API real de LiteLLM
ni de un navegador.

## 1. Tests unitarios / de integración (rápidos, sin red)

Cubren la lógica del servicio (store, caché, prefetch, status, validación de
payloads, manejo de errores) con `callLiteLLM` **mockeado** — no llaman a la API
real ni arrancan un servidor en producción.

```bash
cd /workspace/komga/annotations-service
npm test
# o: node --test test/
```

Usan `node:test` (sin dependencias externas) y un servidor HTTP efímero en un
puerto aleatorio. Cada test crea su propia base SQLite temporal.

## 2. Smoke test end-to-end (contra servicios reales)

Valida el pipeline completo contra el servicio de anotaciones **real** (8787) y,
si hay sesión, el proxy de Komga (25600). Usa una imagen real de manga
(`/workspace/ocr_test/manga/sample_manga.png`) para que el OCR devuelva texto.

```bash
cd /workspace/komga/annotations-service
npm run smoke
# o: node scripts/smoke.js
```

Comprueba: health, POST analiza (devuelve blocks[]), GET del store, 404 de página
inexistente, GET /status, POST /prefetch (202 + queda en store), y el proxy de
Komga (health + propagación de 404).

> El bloque del proxy de Komga devuelve **401 sin sesión** (la cookie del
> navegador del sandbox). Se informa como aviso, no como fallo: el proxy se
> valida desde el navegador con la sesión activa.

## Arquitectura testeable

- `src/app.js` — expone `createApp(opts)` con dependencias inyectables
  (`callLiteLLM`, `dbPath`, modelos, orígenes CORS). Toda la lógica vive aquí.
- `src/server.js` — punto de arranque: importa `createApp()` y hace `app.listen()`.

Esto permite importar la app en tests sin arrancar el servidor y sin llamar a la
API real, inyectando un `callLiteLLM` falso.

## Cómo añadir un test

1. Añade el caso en `test/annotations.test.js` (o un fichero nuevo en `test/`).
2. Si necesitas un LLM distinto, crea un `createApp({ callLiteLLM: ... })` propio.
3. Ejecuta `npm test`.
