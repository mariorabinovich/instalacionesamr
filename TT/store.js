'use strict';
/* =============================================================================
 * store.js — Despachador de almacenamiento
 * =============================================================================
 * Elige automáticamente dónde vivir según el entorno:
 *
 *   - Si existe DATABASE_URL  → store-pg.js (Postgres externo, sobrevive a
 *     redespliegues y funciona en hostings sin disco, como el plan free de
 *     Render). Ver LEEME.md para conseguir uno gratis en Neon.
 *
 *   - Si no existe            → store-local.js (archivos JSON en ./data).
 *     Ideal para correrlo en tu computadora, o en un Docker/VPS con un
 *     volumen real montado.
 *
 * server.js llama siempre a través de este archivo y usa `await` en cada
 * función, así funciona igual sin importar cuál backend esté activo (uno es
 * síncrono, el otro asincrónico contra la red).
 * ========================================================================== */

let impl;
if (process.env.DATABASE_URL) {
  impl = require('./store-pg');
  console.log('  Almacenamiento: Postgres externo (DATABASE_URL definido)');
} else {
  impl = require('./store-local');
  console.log('  Almacenamiento: archivos locales en ./data (sin DATABASE_URL)');
}

module.exports = impl;
