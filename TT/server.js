#!/usr/bin/env node
'use strict';
/* =============================================================================
 * Verificación Higrotérmica — Servidor
 * =============================================================================
 * - Usuarios individuales creados por un administrador, cada uno con su clave.
 * - Registro de accesos: quién entró, desde qué IP, cuándo, y qué exportó.
 * - Generación de archivos (Excel / informe / diseño) del lado del servidor:
 *   el navegador solo los recibe ya hechos y con sesión válida.
 *
 * Libre, sin login: diseñar muros, calcular, editar capas y visualizar.
 * Requiere login: exportar Excel, generar informes, exportar el diseño.
 *
 * Arranque:   npm install && node server.js   →  http://localhost:3000
 * ========================================================================== */

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const XLSX = require('xlsx');
const store = require('./store');

const PORT = Number(process.env.PORT || 3000);
// En un hosting hay que escuchar en 0.0.0.0; en local alcanza con 127.0.0.1.
const HOST = process.env.VH_HOST || (process.env.PORT ? '0.0.0.0' : '127.0.0.1');
const PUBLIC_DIR = path.join(__dirname, 'public');

const SESSION_SECRET = process.env.VH_SESSION_SECRET || crypto.randomBytes(32).toString('hex');
const SESSION_TTL_MS = 1000 * 60 * 60 * 8; // 8 horas
const SECURE_COOKIE = process.env.VH_SECURE_COOKIE === '1';

// Límite de intentos por IP, además del bloqueo por usuario de store.js
const MAX_IP_ATTEMPTS = 20;
const IP_WINDOW_MS = 1000 * 60 * 15;
const ipAttempts = new Map();

// ---------------------------------------------------------------------------
// Sesiones: token firmado (id.exp.firma). Sin base de datos de sesiones.
// ---------------------------------------------------------------------------
function signSession(userId, expiresAt) {
  const payload = `${userId}.${expiresAt}`;
  const sig = crypto.createHmac('sha256', SESSION_SECRET).update(payload).digest('hex');
  return `${payload}.${sig}`;
}
function verifySession(token) {
  if (!token || typeof token !== 'string') return null;
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  const [userId, expStr, sig] = parts;
  const expected = crypto.createHmac('sha256', SESSION_SECRET).update(`${userId}.${expStr}`).digest('hex');
  let a, b;
  try { a = Buffer.from(sig, 'hex'); b = Buffer.from(expected, 'hex'); } catch (_) { return null; }
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  if (!(Date.now() < Number(expStr))) return null;
  const user = store.loadUsers().find((u) => u.id === userId);
  if (!user || !user.active) return null;
  return store.sanitize(user);
}
function parseCookies(req) {
  const out = {};
  (req.headers.cookie || '').split(';').forEach((p) => {
    const i = p.indexOf('=');
    if (i > -1) out[p.slice(0, i).trim()] = decodeURIComponent(p.slice(i + 1).trim());
  });
  return out;
}
function currentUser(req) { return verifySession(parseCookies(req).vh_session); }
function sessionCookie(token, maxAgeSec) {
  return `vh_session=${encodeURIComponent(token)}; HttpOnly; SameSite=Strict; Path=/;${SECURE_COOKIE ? ' Secure;' : ''} Max-Age=${maxAgeSec}`;
}
function clientIP(req) {
  // Detrás de un proxy inverso (Render, nginx) la IP real viene en cabeceras.
  const fwd = req.headers['x-forwarded-for'];
  if (fwd) return String(fwd).split(',')[0].trim();
  return (req.socket && req.socket.remoteAddress) || 'desconocida';
}
function userAgent(req) { return String(req.headers['user-agent'] || '').slice(0, 200); }

function ipRateLimited(ip) {
  const r = ipAttempts.get(ip);
  if (!r) return false;
  if (Date.now() - r.firstAt > IP_WINDOW_MS) { ipAttempts.delete(ip); return false; }
  return r.count >= MAX_IP_ATTEMPTS;
}
function noteIPAttempt(ip) {
  const r = ipAttempts.get(ip);
  if (!r || Date.now() - r.firstAt > IP_WINDOW_MS) ipAttempts.set(ip, { count: 1, firstAt: Date.now() });
  else r.count += 1;
}

// ---------------------------------------------------------------------------
// Utilidades HTTP
// ---------------------------------------------------------------------------
function readBody(req, limit = 3 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) { reject(new Error('payload demasiado grande')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}
async function readJSON(req) {
  try { return JSON.parse((await readBody(req)) || '{}'); } catch (_) { return null; }
}
function sendJSON(res, code, obj, headers = {}) {
  const body = JSON.stringify(obj);
  res.writeHead(code, Object.assign({
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
  }, headers));
  res.end(body);
}

// ---------------------------------------------------------------------------
// Generación de archivos
// ---------------------------------------------------------------------------
const TEXTURE_CHARS = {
  'brick-hollow': '▦', 'brick-solid': '▦', 'block': '▤', 'concrete': '▓',
  'insulation-fiber': '▒', 'insulation-board': '░', 'render': '·', 'plaster': '·',
  'wood': '▥', 'membrane': '▬', 'air-gap': '⠀', 'tile': '▧', 'board': '▨',
};
function num(v, d) {
  if (v == null || v === '' || !Number.isFinite(Number(v))) return '';
  return Number(Number(v).toFixed(d));
}
function fmt(v, d) {
  if (v == null || v === '' || !Number.isFinite(Number(v))) return '—';
  return Number(v).toFixed(d);
}
function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, (ch) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
}

function buildWorkbook(payload, actor) {
  const { projectInfo = {}, settings = {}, results = {}, iramRows = [], layers = [] } = payload;
  const wb = XLSX.utils.book_new();

  const resumen = [
    ['VERIFICACIÓN HIGROTÉRMICA — Memoria de cálculo', ''],
    ['', ''],
    ['Proyecto', projectInfo.nombre || ''],
    ['Ubicación', projectInfo.ubicacion || ''],
    ['Autor del proyecto', projectInfo.autor || ''],
    ['Muro', projectInfo.muro || ''],
    ['Emitido por (usuario)', actor ? `${actor.username}${actor.nombre ? ' — ' + actor.nombre : ''}` : ''],
    ['Fecha de emisión', new Date().toLocaleString('es-AR')],
    ['', ''],
    ['RESULTADOS', ''],
    ['Transmitancia térmica K (W/m²K)', num(results.K, 4)],
    ['Resistencia térmica total RT (m²K/W)', num(results.RT, 4)],
    ['K máx. adm. invierno (Nivel ' + (settings.nivel || '') + ')', num(results.kmaxInvierno, 3)],
    ['¿Cumple invierno?', results.cumpleInvierno ? 'SI' : 'NO'],
    ['K máx. adm. verano (Nivel ' + (settings.nivel || '') + ')', num(results.kmaxVerano, 3)],
    ['¿Cumple verano?', results.cumpleVerano ? 'SI' : 'NO'],
    ['Riesgo de condensación superficial', results.riesgoSuperficial ? 'SI' : 'NO'],
    ['Riesgo de condensación intersticial', results.riesgoIntersticial ? 'SI' : 'NO'],
    ['', ''],
    ['CONDICIONES DE CÁLCULO', ''],
    ['TDMN (K máx, IRAM 11603) °C', num(settings.tdmn, 2)],
    ['Zona bioambiental (verano)', settings.zonaGrupo || ''],
    ['Nivel de exigencia (IRAM 11605)', settings.nivel || ''],
    ['Temp. interior ti (°C)', num(settings.ti, 1)],
    ['Humedad relativa interior RHi (%)', num(settings.RHi, 0)],
    ['Temp. exterior condensación (°C)', num(settings.teCond, 2)],
    ['Humedad relativa exterior RHe (%)', num(settings.RHe, 0)],
    ['', ''],
    ['Fuentes', 'IRAM 11601:2002, IRAM 11603, IRAM 11605:1996 (Mod.1:2002), IRAM 11625, Cód. Edificación CABA RT-000000-030301-00'],
    ['Nota', 'Herramienta de apoyo al diseño. Los valores [ORIENTATIVO] deben verificarse con ensayo o ficha del fabricante antes de presentar ante el GCBA.'],
  ];
  const wsR = XLSX.utils.aoa_to_sheet(resumen);
  wsR['!cols'] = [{ wch: 36 }, { wch: 50 }];
  XLSX.utils.book_append_sheet(wb, wsR, 'Resumen');

  const aoa = [['N°', 'Capa / Intersticio', 'e (m)', 'λ (W/m.K)', 'R (m²K/W)', 'T (°C)',
    'δ (g/m.h.kPa)', 'Rv (m².h.kPa/g)', 'φ (%)', 'P (kPa)', 'tR (°C)', 'Δt (°C)']];
  iramRows.forEach((r) => {
    if (r.kind === 'total') {
      aoa.push(['', r.capa || 'TOTALES', num(r.e, 4), '', num(r.R, 4), '', '', num(r.Rv, 4), '', '', '', '']);
    } else if (r.kind === 'layer') {
      aoa.push([r.n == null ? '' : r.n, (r.capa || '') + (r.isTestedR ? ' (R de ensayo)' : ''),
        num(r.e, 4), num(r.lambda, 3), num(r.R, 4), '', num(r.delta, 3), num(r.Rv, 4), '', '', '', '']);
    } else {
      aoa.push(['', r.capa || '(intersticio)', '', '', '', num(r.T, 2), '', '',
        num(r.phi, 0), num(r.P, 3), num(r.tR, 2), num(r.deltaT, 2)]);
    }
  });
  const wsI = XLSX.utils.aoa_to_sheet(aoa);
  wsI['!cols'] = [{ wch: 5 }, { wch: 38 }, { wch: 9 }, { wch: 10 }, { wch: 10 }, { wch: 8 },
    { wch: 13 }, { wch: 15 }, { wch: 7 }, { wch: 9 }, { wch: 8 }, { wch: 8 }];
  XLSX.utils.book_append_sheet(wb, wsI, 'Planilla IRAM 11625');

  if (layers.length) {
    const REF = 32, MINW = 7, MAXW = 42, TEX = 7;
    const widths = layers.map((l) => Math.max(MINW, Math.min(MAXW, ((l.e || 0) * 100 / REF) * 34)));
    const rows = [];
    rows.push(['MURO — INTERIOR → EXTERIOR (ancho de columna ≈ espesor real)', ...Array(Math.max(0, layers.length - 1)).fill('')]);
    rows.push(layers.map((l, i) => `${i + 1}. ${l.name || ''}`));
    for (let r = 0; r < TEX; r++) rows.push(layers.map((l) => (TEXTURE_CHARS[l.kind] || '·').repeat(4)));
    rows.push(layers.map((l) => `e = ${((l.e || 0) * 100).toFixed((l.e || 0) < 0.01 ? 2 : 1)} cm`));
    rows.push(layers.map((l) => (l.directR != null ? `R = ${Number(l.directR).toFixed(3)} (ensayo)` : `λ = ${l.lambda}`)));
    rows.push(layers.map((l) => (l.thetaInt != null ? `θ int. = ${Number(l.thetaInt).toFixed(1)}°C` : '')));
    rows.push(layers.map((l) => (l.thetaExt != null ? `θ ext. = ${Number(l.thetaExt).toFixed(1)}°C` : '')));
    rows.push(layers.map((l) => (l.riesgo ? '⚠ RIESGO DE CONDENSACIÓN' : '')));
    const wsE = XLSX.utils.aoa_to_sheet(rows);
    wsE['!cols'] = widths.map((w) => ({ wch: w }));
    wsE['!rows'] = [{ hpt: 22 }, { hpt: 30 }].concat(Array(TEX).fill({ hpt: 20 }),
      [{ hpt: 18 }, { hpt: 18 }, { hpt: 18 }, { hpt: 18 }, { hpt: 18 }]);
    if (layers.length > 1) wsE['!merges'] = [{ s: { r: 0, c: 0 }, e: { r: 0, c: layers.length - 1 } }];
    XLSX.utils.book_append_sheet(wb, wsE, 'Esquema del muro');
  }
  return XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
}

function buildReportHTML(payload, actor) {
  const { projectInfo = {}, settings = {}, results = {}, iramRows = [] } = payload;
  const verdict = (ok, a, b) => `<span class="verdict ${ok ? 'ok' : 'bad'}">${ok ? a : b}</span>`;
  const rowsHtml = iramRows.map((r) => {
    if (r.kind === 'total') {
      return `<tr class="total"><td></td><td>${esc(r.capa || 'TOTALES')}</td><td>${fmt(r.e, 3)}</td><td>—</td><td>${fmt(r.R, 3)}</td><td>—</td><td>—</td><td>${fmt(r.Rv, 4)}</td><td>—</td><td>—</td><td>—</td><td>—</td></tr>`;
    }
    if (r.kind === 'layer') {
      return `<tr><td>${esc(r.n == null ? '' : r.n)}</td><td class="capa">${esc(r.capa || '')}${r.isTestedR ? ' <em>(R ensayo)</em>' : ''}</td><td>${fmt(r.e, 3)}</td><td>${fmt(r.lambda, 3)}</td><td>${fmt(r.R, 3)}</td><td>—</td><td>${fmt(r.delta, 2)}</td><td>${fmt(r.Rv, 4)}</td><td>—</td><td>—</td><td>—</td><td>—</td></tr>`;
    }
    const dt = r.deltaT == null ? '—' : (Number(r.deltaT) <= 0 ? `<b>${Number(r.deltaT).toFixed(2)}</b>` : Number(r.deltaT).toFixed(2));
    return `<tr class="interface${r.riesgo ? ' risk' : ''}"><td></td><td class="capa air">${esc(r.capa || '')}</td><td>—</td><td>—</td><td>—</td><td>${fmt(r.T, 2)}</td><td>—</td><td>—</td><td>${fmt(r.phi, 0)}</td><td>${fmt(r.P, 3)}</td><td>${fmt(r.tR, 2)}</td><td>${dt}</td></tr>`;
  }).join('');

  return `<!DOCTYPE html><html lang="es"><head><meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1"><title>Informe · Verificación Higrotérmica</title>
<style>
 @page { size: A4; margin: 15mm; }
 body { font-family: -apple-system, "Segoe UI", Roboto, sans-serif; color:#1a1a1a; line-height:1.5; max-width:900px; margin:0 auto; padding:24px; }
 h1 { font-size:20px; border-bottom:2px solid #333; padding-bottom:8px; margin-bottom:4px; }
 h2 { font-size:14px; margin-top:22px; text-transform:uppercase; letter-spacing:.5px; color:#444; border-bottom:1px solid #ddd; padding-bottom:4px; }
 .meta { display:grid; grid-template-columns:1fr 1fr; gap:4px 20px; font-size:12px; margin:12px 0; }
 .k-big { font-size:30px; font-weight:700; margin:10px 0; }
 table { width:100%; border-collapse:collapse; font-size:10px; margin-top:8px; }
 th { background:#eee; border:1px solid #bbb; padding:5px 4px; text-align:center; font-size:9.5px; }
 td { border:1px solid #ddd; padding:4px; text-align:center; }
 td.capa { text-align:left; font-size:11px; }
 td.capa.air { color:#888; font-style:italic; font-size:9.5px; }
 tr.interface { background:#eef4f9; -webkit-print-color-adjust:exact; print-color-adjust:exact; }
 tr.interface.risk { background:#fbe2e1; }
 tr.total { background:#eee; font-weight:700; }
 .verdict { display:inline-block; padding:3px 10px; border-radius:4px; font-weight:600; font-size:12px; }
 .verdict.ok { background:#e2f4ea; color:#1e7a4c; } .verdict.bad { background:#fbe2e1; color:#b32a26; }
 .note { background:#f6f6f2; border:1px solid #ddd; padding:10px 12px; font-size:10.5px; margin-top:16px; border-radius:4px; }
 .foot { margin-top:14px; font-size:9.5px; color:#777; border-top:1px solid #ddd; padding-top:8px; }
 @media print { .noprint { display:none; } }
</style></head><body>
<div class="noprint" style="background:#eef4f9;padding:10px 14px;border-radius:6px;margin-bottom:16px;font-size:13px;">
 Informe generado en el servidor. Usá <b>Imprimir → Guardar como PDF</b> para archivarlo.
 <button onclick="window.print()" style="margin-left:10px;padding:6px 12px;">🖨 Imprimir</button></div>
<h1>Verificación Higrotérmica · Informe de cálculo</h1>
<div class="meta">
 <div><b>Proyecto:</b> ${esc(projectInfo.nombre) || '—'}</div>
 <div><b>Ubicación:</b> ${esc(projectInfo.ubicacion) || '—'}</div>
 <div><b>Autor del proyecto:</b> ${esc(projectInfo.autor) || '—'}</div>
 <div><b>Muro:</b> ${esc(projectInfo.muro) || '—'}</div>
 <div><b>Emitido por:</b> ${esc(actor ? actor.username : '—')}</div>
 <div><b>Fecha:</b> ${new Date().toLocaleString('es-AR')}</div>
</div>
<h2>1. Condiciones de cálculo</h2>
<div class="meta">
 <div><b>TDMN (IRAM 11603):</b> ${fmt(settings.tdmn, 1)} °C</div>
 <div><b>Zona bioambiental:</b> ${esc(settings.zonaGrupo)}</div>
 <div><b>Nivel de exigencia:</b> ${esc(settings.nivel)}</div>
 <div><b>Interior:</b> ${fmt(settings.ti, 1)} °C / ${fmt(settings.RHi, 0)} %</div>
 <div><b>Exterior (condensación):</b> ${fmt(settings.teCond, 1)} °C / ${fmt(settings.RHe, 0)} %</div>
</div>
<h2>2. Transmitancia térmica</h2>
<div class="k-big">K = ${fmt(results.K, 3)} W/m²K</div>
<table><tr><th></th><th>K máximo admisible</th><th>Resultado</th></tr>
 <tr><td>Condición de invierno</td><td>${fmt(results.kmaxInvierno, 2)} W/m²K</td><td>${verdict(results.cumpleInvierno, 'Cumple', 'No cumple')}</td></tr>
 <tr><td>Condición de verano</td><td>${fmt(results.kmaxVerano, 2)} W/m²K</td><td>${verdict(results.cumpleVerano, 'Cumple', 'No cumple')}</td></tr></table>
<h2>3. Condensación superficial (IRAM 11625)</h2>
<p style="font-size:12px;">θ superficie interior: <b>${fmt(results.thetaSI, 1)} °C</b> · Punto de rocío interior: <b>${fmt(results.tRocioInterior, 1)} °C</b></p>
${verdict(!results.riesgoSuperficial, 'Sin riesgo de condensación superficial', 'Riesgo de condensación superficial')}
<h2>4. Condensación intersticial — Planilla IRAM 11625</h2>
<table><tr><th>N°</th><th>Capa / Intersticio</th><th>e<br>m</th><th>λ<br>W/m.K</th><th>R<br>m²K/W</th><th>T<br>°C</th><th>δ<br>g/m.h.kPa</th><th>Rv<br>m².h.kPa/g</th><th>φ<br>%</th><th>P<br>kPa</th><th>t<sub>R</sub><br>°C</th><th>Δt<br>°C</th></tr>
${rowsHtml}</table>
<p style="margin-top:10px;">${verdict(!results.riesgoIntersticial, 'Sin riesgo de condensación intersticial', 'Riesgo de condensación intersticial')}</p>
<p style="font-size:10.5px;color:#666;">Δt = T − t<sub>R</sub>. Si Δt ≤ 0 hay riesgo de condensación (fila resaltada). Las filas sombreadas son <b>intersticios</b> entre capas, donde se evalúan T y P.</p>
<div class="note"><b>Herramienta de apoyo al diseño.</b> Los materiales marcados [ORIENTATIVO] deben confirmarse con ensayo IRAM 11559/11564 o ficha del fabricante antes de su presentación ante el GCBA.</div>
<div class="foot">Generado en el servidor · Fuentes: IRAM 11601:2002, IRAM 11603, IRAM 11605:1996 (Mod. 1:2002), IRAM 11625 · Código de Edificación CABA, RT-000000-030301-00.</div>
</body></html>`;
}

// ---------------------------------------------------------------------------
// Servidor
// ---------------------------------------------------------------------------
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const p = url.pathname;
  const ip = clientIP(req);

  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('X-Frame-Options', 'SAMEORIGIN');

  try {
    // ---------------- Sesión ----------------
    if (p === '/api/session' && req.method === 'GET') {
      const u = currentUser(req);
      return sendJSON(res, 200, {
        authed: !!u,
        user: u ? { username: u.username, nombre: u.nombre, role: u.role, mustChangePassword: !!u.mustChangePassword } : null,
      });
    }

    if (p === '/api/login' && req.method === 'POST') {
      if (ipRateLimited(ip)) {
        store.logEvent({ event: 'login_blocked_ip', ip, ua: userAgent(req) });
        return sendJSON(res, 429, { ok: false, error: 'Demasiados intentos desde esta dirección. Esperá unos minutos.' });
      }
      const body = await readJSON(req);
      if (!body) return sendJSON(res, 400, { ok: false, error: 'Petición inválida.' });
      const r = store.authenticate(body.username, body.password);
      if (!r.ok) {
        noteIPAttempt(ip);
        store.logEvent({ event: 'login_fail', username: String(body.username || '').slice(0, 40), ip, ua: userAgent(req), motivo: r.reason });
        const msg = r.reason === 'inactivo' ? 'La cuenta está desactivada. Contactá al administrador.'
          : r.reason === 'bloqueado' ? 'Cuenta bloqueada temporalmente por intentos fallidos. Probá en unos minutos.'
          : 'Usuario o contraseña incorrectos.';
        return sendJSON(res, 401, { ok: false, error: msg });
      }
      store.recordLoginIP(r.user.id, ip);
      store.logEvent({ event: 'login_ok', username: r.user.username, ip, ua: userAgent(req), role: r.user.role });
      const exp = Date.now() + SESSION_TTL_MS;
      return sendJSON(res, 200, {
        ok: true,
        user: { username: r.user.username, nombre: r.user.nombre, role: r.user.role, mustChangePassword: !!r.user.mustChangePassword },
      }, { 'Set-Cookie': sessionCookie(signSession(r.user.id, exp), Math.floor(SESSION_TTL_MS / 1000)) });
    }

    if (p === '/api/logout' && req.method === 'POST') {
      const u = currentUser(req);
      if (u) store.logEvent({ event: 'logout', username: u.username, ip, ua: userAgent(req) });
      return sendJSON(res, 200, { ok: true }, { 'Set-Cookie': 'vh_session=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0' });
    }

    if (p === '/api/change-password' && req.method === 'POST') {
      const u = currentUser(req);
      if (!u) return sendJSON(res, 401, { ok: false, error: 'Sesión no válida.' });
      const body = await readJSON(req);
      if (!body) return sendJSON(res, 400, { ok: false, error: 'Petición inválida.' });
      const full = store.loadUsers().find((x) => x.id === u.id);
      if (!store.verifyPassword(body.actual, full.passwordHash)) {
        store.logEvent({ event: 'password_change_fail', username: u.username, ip, ua: userAgent(req) });
        return sendJSON(res, 401, { ok: false, error: 'La contraseña actual no es correcta.' });
      }
      try {
        store.updateUser(u.id, { password: body.nueva, mustChangePassword: false }, u.username);
        store.logEvent({ event: 'password_change_ok', username: u.username, ip, ua: userAgent(req) });
        return sendJSON(res, 200, { ok: true });
      } catch (e) { return sendJSON(res, 400, { ok: false, error: e.message }); }
    }

    // ---------------- Exportaciones (requieren sesión) ----------------
    if (p.indexOf('/api/export/') === 0) {
      if (req.method !== 'POST') { res.writeHead(405); return res.end('Método no permitido'); }
      const u = currentUser(req);
      if (!u) {
        store.logEvent({ event: 'export_denied', ip, ua: userAgent(req), ruta: p });
        return sendJSON(res, 401, { ok: false, error: 'Necesitás iniciar sesión para exportar.' });
      }
      const payload = await readJSON(req);
      if (!payload) return sendJSON(res, 400, { ok: false, error: 'Datos de cálculo inválidos.' });

      const slug = String((payload.projectInfo && payload.projectInfo.muro) || 'muro')
        .replace(/[^a-z0-9]/gi, '_').toLowerCase().slice(0, 40) || 'muro';
      const stamp = new Date().toISOString().slice(0, 10);
      const meta = {
        username: u.username, ip, ua: userAgent(req),
        muro: (payload.projectInfo && payload.projectInfo.muro) || '',
        proyecto: (payload.projectInfo && payload.projectInfo.nombre) || '',
      };

      if (p === '/api/export/excel') {
        const buf = buildWorkbook(payload, u);
        store.logEvent(Object.assign({ event: 'export_excel' }, meta));
        res.writeHead(200, {
          'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
          'Content-Disposition': `attachment; filename="verificacion_higrotermica_${slug}_${stamp}.xlsx"`,
          'Content-Length': buf.length, 'Cache-Control': 'no-store',
        });
        return res.end(buf);
      }
      if (p === '/api/export/report') {
        const html = buildReportHTML(payload, u);
        store.logEvent(Object.assign({ event: 'export_report' }, meta));
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Content-Length': Buffer.byteLength(html), 'Cache-Control': 'no-store' });
        return res.end(html);
      }
      if (p === '/api/export/design') {
        const out = JSON.stringify({
          _app: 'Verificación Higrotérmica', _version: 13,
          _exportedAt: new Date().toISOString(), _exportedBy: u.username,
          layers: payload.layers || [], settings: payload.settings || {},
          wallType: payload.wallType || 'fachada', projectInfo: payload.projectInfo || {},
        }, null, 2);
        store.logEvent(Object.assign({ event: 'export_design' }, meta));
        res.writeHead(200, {
          'Content-Type': 'application/json; charset=utf-8',
          'Content-Disposition': `attachment; filename="diseno_${slug}_${stamp}.json"`,
          'Content-Length': Buffer.byteLength(out), 'Cache-Control': 'no-store',
        });
        return res.end(out);
      }
      return sendJSON(res, 404, { ok: false, error: 'Exportación desconocida.' });
    }

    // ---------------- Administración (requiere rol admin) ----------------
    if (p.indexOf('/api/admin/') === 0) {
      const u = currentUser(req);
      if (!u) return sendJSON(res, 401, { ok: false, error: 'Sesión no válida.' });
      if (u.role !== 'admin') {
        store.logEvent({ event: 'admin_denied', username: u.username, ip, ua: userAgent(req), ruta: p });
        return sendJSON(res, 403, { ok: false, error: 'Se requieren permisos de administrador.' });
      }

      if (p === '/api/admin/users' && req.method === 'GET') {
        return sendJSON(res, 200, { ok: true, users: store.listUsers() });
      }
      if (p === '/api/admin/users' && req.method === 'POST') {
        const b = await readJSON(req);
        if (!b) return sendJSON(res, 400, { ok: false, error: 'Petición inválida.' });
        try {
          const nu = store.createUser({
            username: b.username, password: b.password, role: b.role || 'user',
            nombre: b.nombre, email: b.email, createdBy: u.username,
          });
          store.logEvent({ event: 'user_create', username: u.username, ip, ua: userAgent(req), objetivo: nu.username, rol: nu.role });
          return sendJSON(res, 200, { ok: true, user: nu });
        } catch (e) { return sendJSON(res, 400, { ok: false, error: e.message }); }
      }
      if (p.indexOf('/api/admin/users/') === 0 && (req.method === 'PATCH' || req.method === 'PUT')) {
        const id = p.split('/').pop();
        const b = await readJSON(req);
        if (!b) return sendJSON(res, 400, { ok: false, error: 'Petición inválida.' });
        try {
          const nu = store.updateUser(id, b, u.username);
          const cambios = Object.keys(b).filter((k) => k !== 'password');
          if (b.password) cambios.push('password');
          store.logEvent({ event: 'user_update', username: u.username, ip, ua: userAgent(req), objetivo: nu.username, cambios: cambios.join(',') });
          return sendJSON(res, 200, { ok: true, user: nu });
        } catch (e) { return sendJSON(res, 400, { ok: false, error: e.message }); }
      }
      if (p.indexOf('/api/admin/users/') === 0 && req.method === 'DELETE') {
        const id = p.split('/').pop();
        const target = store.loadUsers().find((x) => x.id === id);
        try {
          store.deleteUser(id);
          store.logEvent({ event: 'user_delete', username: u.username, ip, ua: userAgent(req), objetivo: target ? target.username : id });
          return sendJSON(res, 200, { ok: true });
        } catch (e) { return sendJSON(res, 400, { ok: false, error: e.message }); }
      }
      if (p === '/api/admin/log' && req.method === 'GET') {
        const limit = Math.min(1000, Number(url.searchParams.get('limit') || 200));
        const username = url.searchParams.get('username') || null;
        const event = url.searchParams.get('event') || null;
        return sendJSON(res, 200, { ok: true, entries: store.readLog({ limit, username, event }), stats: store.logStats() });
      }
      return sendJSON(res, 404, { ok: false, error: 'Recurso de administración desconocido.' });
    }

    // ---------------- Estáticos ----------------
    if (req.method === 'GET' || req.method === 'HEAD') {
      if (p === '/admin' || p === '/admin.html') {
        const u = currentUser(req);
        if (!u || u.role !== 'admin') { res.writeHead(302, { Location: '/?admin=1' }); return res.end(); }
        const data = fs.readFileSync(path.join(PUBLIC_DIR, 'admin.html'));
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Content-Length': data.length, 'Cache-Control': 'no-store' });
        return res.end(req.method === 'HEAD' ? undefined : data);
      }
      const rel = (p === '/' || p === '') ? 'index.html' : p.replace(/^\/+/, '');
      const safe = path.normalize(rel).replace(/^(\.\.[/\\])+/, '');
      const full = path.join(PUBLIC_DIR, safe);
      if (full.indexOf(PUBLIC_DIR) !== 0) { res.writeHead(403); return res.end('Prohibido'); }
      if (fs.existsSync(full) && fs.statSync(full).isFile()) {
        const ext = path.extname(full).toLowerCase();
        const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
          '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8',
          '.png': 'image/png', '.jpg': 'image/jpeg', '.svg': 'image/svg+xml', '.ico': 'image/x-icon' };
        const data = fs.readFileSync(full);
        res.writeHead(200, { 'Content-Type': types[ext] || 'application/octet-stream', 'Content-Length': data.length });
        return res.end(req.method === 'HEAD' ? undefined : data);
      }
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      return res.end('No encontrado');
    }

    res.writeHead(405); res.end('Método no permitido');
  } catch (err) {
    console.error('Error procesando la petición:', err && err.message);
    if (!res.headersSent) sendJSON(res, 500, { ok: false, error: 'Error interno del servidor.' });
    else res.end();
  }
});

// ---------------------------------------------------------------------------
// Arranque
// ---------------------------------------------------------------------------
const boot = store.bootstrapAdmin();
server.listen(PORT, HOST, () => {
  console.log('');
  console.log('  Verificación Higrotérmica — servidor activo');
  console.log('  ==========================================');
  console.log(`  URL:   http://${HOST === '0.0.0.0' ? 'localhost' : HOST}:${PORT}`);
  console.log(`  Datos: ${store.DATA_DIR}`);
  console.log('');
  console.log('  Sin login:  diseñar, calcular, editar capas, visualizar.');
  console.log('  Con login:  exportar Excel / informes / diseño.');
  console.log('  Admin:      /admin  (usuarios y registro de accesos)');
  if (boot) {
    console.log('');
    console.log('  +------------------------------------------------------+');
    console.log('  |  PRIMER ARRANQUE - administrador creado               |');
    console.log('  +------------------------------------------------------+');
    console.log(`  |  Usuario:     ${boot.username}`);
    console.log(`  |  Contrasena:  ${boot.password}`);
    console.log('  +------------------------------------------------------+');
    if (boot.generated) {
      console.log('  |  Clave generada al azar: anotala ahora, no se vuelve  |');
      console.log('  |  a mostrar. La app te pedira cambiarla al entrar.     |');
    } else {
      console.log('  |  Definida por VH_ADMIN_PASSWORD.                      |');
    }
    console.log('  +------------------------------------------------------+');
  }
  if (!process.env.VH_SESSION_SECRET) {
    console.log('');
    console.log('  ! VH_SESSION_SECRET no definido: las sesiones se cierran al reiniciar.');
  }
  console.log('');
});
