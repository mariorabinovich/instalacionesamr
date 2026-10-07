'use strict';
/* =============================================================================
 * store-pg.js — Usuarios, contraseñas y registro de accesos en Postgres
 * =============================================================================
 * Misma interfaz pública que store-local.js (que guarda en archivos JSON).
 * Se usa automáticamente cuando existe la variable de entorno DATABASE_URL
 * (ver store.js, que decide cuál de los dos cargar).
 *
 * Por qué hace falta esto: en hostings gratuitos como Render, el sistema de
 * archivos del contenedor es efímero — se borra en cada redespliegue (y el
 * plan free ni siquiera permite agregarle un disco). Postgres es un servicio
 * aparte que sigue vivo aunque el contenedor de la app se reinicie o se
 * vuelva a desplegar. Neon (neon.tech) da un proyecto Postgres gratis de
 * forma permanente, no por tiempo limitado — ver LEEME.md para el alta.
 *
 * Nota honesta: este archivo se revisó con cuidado (consultas parametrizadas,
 * sin concatenar valores del usuario en el SQL) pero no pudo probarse contra
 * un Postgres real en este entorno, que no tiene salida de red hacia
 * servicios externos. El backend local (store-local.js) sí está probado de
 * punta a punta. Antes de confiar en producción, probá el alta de un
 * usuario y un login apenas lo despliegues.
 * ========================================================================== */

const crypto = require('crypto');
const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.VH_PG_NO_SSL === '1' ? false : { rejectUnauthorized: false },
});

let schemaReady = null;
function ensureSchema() {
  if (schemaReady) return schemaReady;
  schemaReady = pool.query(`
    CREATE TABLE IF NOT EXISTS vh_users (
      id UUID PRIMARY KEY,
      username TEXT UNIQUE NOT NULL,
      nombre TEXT DEFAULT '',
      email TEXT DEFAULT '',
      role TEXT NOT NULL DEFAULT 'user',
      password_hash TEXT NOT NULL,
      active BOOLEAN NOT NULL DEFAULT true,
      must_change_password BOOLEAN NOT NULL DEFAULT true,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      created_by TEXT,
      updated_at TIMESTAMPTZ,
      updated_by TEXT,
      password_changed_at TIMESTAMPTZ,
      password_changed_by TEXT,
      last_login_at TIMESTAMPTZ,
      last_login_ip TEXT,
      login_count INTEGER NOT NULL DEFAULT 0,
      failed_attempts INTEGER NOT NULL DEFAULT 0,
      locked_until TIMESTAMPTZ
    );
    CREATE TABLE IF NOT EXISTS vh_access_log (
      id BIGSERIAL PRIMARY KEY,
      at TIMESTAMPTZ NOT NULL DEFAULT now(),
      event TEXT NOT NULL,
      username TEXT,
      ip TEXT,
      ua TEXT,
      detail JSONB
    );
    CREATE INDEX IF NOT EXISTS vh_access_log_at_idx ON vh_access_log (at DESC);
    CREATE INDEX IF NOT EXISTS vh_access_log_username_idx ON vh_access_log (username);
  `).catch((e) => { schemaReady = null; throw e; });
  return schemaReady;
}

function hashPassword(plain) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(String(plain), salt, 64);
  return `${salt.toString('hex')}:${hash.toString('hex')}`;
}
function verifyPassword(plain, stored) {
  try {
    const [saltHex, hashHex] = String(stored).split(':');
    if (!saltHex || !hashHex) return false;
    const salt = Buffer.from(saltHex, 'hex');
    const expected = Buffer.from(hashHex, 'hex');
    const actual = crypto.scryptSync(String(plain), salt, 64);
    return actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
  } catch (_) { return false; }
}
function validatePassword(plain) {
  const s = String(plain || '');
  if (s.length < 8) return 'La contraseña debe tener al menos 8 caracteres.';
  if (!/[a-zA-Z]/.test(s) || !/[0-9]/.test(s)) return 'La contraseña debe incluir al menos una letra y un número.';
  return null;
}
function validateUsername(u) {
  const s = String(u || '').trim();
  if (s.length < 3) return 'El usuario debe tener al menos 3 caracteres.';
  if (s.length > 32) return 'El usuario no puede superar los 32 caracteres.';
  if (!/^[a-zA-Z0-9._-]+$/.test(s)) return 'El usuario solo admite letras, números, punto, guion y guion bajo.';
  return null;
}

function rowToUser(r) {
  if (!r) return null;
  return {
    id: r.id, username: r.username, nombre: r.nombre || '', email: r.email || '',
    role: r.role, passwordHash: r.password_hash, active: r.active,
    mustChangePassword: r.must_change_password, createdAt: r.created_at, createdBy: r.created_by,
    updatedAt: r.updated_at, updatedBy: r.updated_by,
    passwordChangedAt: r.password_changed_at, passwordChangedBy: r.password_changed_by,
    lastLoginAt: r.last_login_at, lastLoginIP: r.last_login_ip,
    loginCount: r.login_count, failedAttempts: r.failed_attempts, lockedUntil: r.locked_until,
  };
}
function sanitize(u) {
  if (!u) return u;
  const { passwordHash, ...rest } = u;
  return rest;
}

async function loadUsers() {
  await ensureSchema();
  const { rows } = await pool.query('SELECT * FROM vh_users ORDER BY created_at ASC');
  return rows.map(rowToUser);
}
async function listUsers() {
  return (await loadUsers()).map(sanitize);
}
async function findUser(username) {
  await ensureSchema();
  const { rows } = await pool.query('SELECT * FROM vh_users WHERE lower(username) = lower($1)', [String(username || '').trim()]);
  return rowToUser(rows[0]);
}
function countActiveAdmins(users, excludeId) {
  return users.filter((x) => x.role === 'admin' && x.active && x.id !== excludeId).length;
}

async function createUser({ username, password, role = 'user', nombre = '', email = '', createdBy = 'sistema' }) {
  await ensureSchema();
  const uErr = validateUsername(username);
  if (uErr) throw new Error(uErr);
  const pErr = validatePassword(password);
  if (pErr) throw new Error(pErr);
  if (!['admin', 'user'].includes(role)) throw new Error('Rol inválido.');
  if (await findUser(username)) throw new Error('Ya existe un usuario con ese nombre.');

  const id = crypto.randomUUID();
  const passwordHash = hashPassword(password);
  const { rows } = await pool.query(
    `INSERT INTO vh_users (id, username, nombre, email, role, password_hash, active, must_change_password, created_by)
     VALUES ($1,$2,$3,$4,$5,$6,true,true,$7) RETURNING *`,
    [id, String(username).trim(), String(nombre || '').slice(0, 80), String(email || '').slice(0, 120), role, passwordHash, createdBy]
  );
  return sanitize(rowToUser(rows[0]));
}

async function updateUser(id, patch, actor = 'sistema') {
  await ensureSchema();
  const { rows } = await pool.query('SELECT * FROM vh_users WHERE id = $1', [id]);
  if (!rows[0]) throw new Error('Usuario inexistente.');
  const u = rowToUser(rows[0]);
  const allUsers = await loadUsers();

  const sets = [], vals = [];
  let i = 1;
  const set = (col, val) => { sets.push(`${col} = $${i++}`); vals.push(val); };

  if (patch.nombre !== undefined) set('nombre', String(patch.nombre).slice(0, 80));
  if (patch.email !== undefined) set('email', String(patch.email).slice(0, 120));
  if (patch.role !== undefined) {
    if (!['admin', 'user'].includes(patch.role)) throw new Error('Rol inválido.');
    if (u.role === 'admin' && patch.role !== 'admin' && countActiveAdmins(allUsers, u.id) === 0) {
      throw new Error('No se puede quitar el último administrador activo.');
    }
    set('role', patch.role);
  }
  if (patch.active !== undefined) {
    const next = !!patch.active;
    if (u.role === 'admin' && !next && countActiveAdmins(allUsers, u.id) === 0) {
      throw new Error('No se puede desactivar el último administrador activo.');
    }
    set('active', next);
    if (next) { set('failed_attempts', 0); set('locked_until', null); }
  }
  if (patch.password) {
    const pErr = validatePassword(patch.password);
    if (pErr) throw new Error(pErr);
    set('password_hash', hashPassword(patch.password));
    set('must_change_password', patch.mustChangePassword !== false);
    set('failed_attempts', 0);
    set('locked_until', null);
    set('password_changed_at', new Date());
    set('password_changed_by', actor);
  }
  set('updated_at', new Date());
  set('updated_by', actor);

  vals.push(id);
  const { rows: updated } = await pool.query(`UPDATE vh_users SET ${sets.join(', ')} WHERE id = $${i} RETURNING *`, vals);
  return sanitize(rowToUser(updated[0]));
}

async function deleteUser(id) {
  await ensureSchema();
  const { rows } = await pool.query('SELECT * FROM vh_users WHERE id = $1', [id]);
  if (!rows[0]) throw new Error('Usuario inexistente.');
  const u = rowToUser(rows[0]);
  if (u.role === 'admin') {
    const all = await loadUsers();
    if (countActiveAdmins(all, u.id) === 0) throw new Error('No se puede eliminar el último administrador activo.');
  }
  await pool.query('DELETE FROM vh_users WHERE id = $1', [id]);
  return true;
}

const MAX_FAILED = 5;
const LOCK_MS = 1000 * 60 * 15;

async function authenticate(username, password) {
  await ensureSchema();
  const u = await findUser(username);
  if (!u) return { ok: false, reason: 'credenciales' };
  if (!u.active) return { ok: false, reason: 'inactivo' };
  if (u.lockedUntil && Date.now() < new Date(u.lockedUntil).getTime()) {
    return { ok: false, reason: 'bloqueado', lockedUntil: u.lockedUntil };
  }
  if (!verifyPassword(password, u.passwordHash)) {
    const failed = (u.failedAttempts || 0) + 1;
    if (failed >= MAX_FAILED) {
      const lockedUntil = new Date(Date.now() + LOCK_MS);
      await pool.query('UPDATE vh_users SET failed_attempts = 0, locked_until = $2 WHERE id = $1', [u.id, lockedUntil]);
      return { ok: false, reason: 'bloqueado', lockedUntil };
    }
    await pool.query('UPDATE vh_users SET failed_attempts = $2 WHERE id = $1', [u.id, failed]);
    return { ok: false, reason: 'credenciales' };
  }
  await pool.query(
    `UPDATE vh_users SET failed_attempts = 0, locked_until = NULL, last_login_at = now(), login_count = login_count + 1 WHERE id = $1`,
    [u.id]
  );
  return { ok: true, user: sanitize(u) };
}

async function recordLoginIP(id, ip) {
  await ensureSchema();
  await pool.query('UPDATE vh_users SET last_login_ip = $2 WHERE id = $1', [id, ip]);
}

async function logEvent(evt) {
  try {
    await ensureSchema();
    const { at, event, username, ip, ua, ...detail } = evt;
    await pool.query(
      'INSERT INTO vh_access_log (event, username, ip, ua, detail) VALUES ($1,$2,$3,$4,$5)',
      [event, username || null, ip || null, ua || null, Object.keys(detail).length ? JSON.stringify(detail) : null]
    );
  } catch (e) {
    console.error('  ⚠ no se pudo escribir el registro de accesos (Postgres):', e.message);
  }
  return Object.assign({ at: new Date().toISOString() }, evt);
}

async function readLog({ limit = 200, username = null, event = null } = {}) {
  await ensureSchema();
  const conds = [], vals = [];
  let i = 1;
  if (username) { conds.push(`lower(username) = lower($${i++})`); vals.push(username); }
  if (event) { conds.push(`event = $${i++}`); vals.push(event); }
  const where = conds.length ? 'WHERE ' + conds.join(' AND ') : '';
  vals.push(Math.min(1000, limit));
  const { rows } = await pool.query(
    `SELECT at, event, username, ip, ua, detail FROM vh_access_log ${where} ORDER BY at DESC LIMIT $${i}`,
    vals
  );
  return rows.map((r) => Object.assign(
    { at: r.at instanceof Date ? r.at.toISOString() : r.at, event: r.event, username: r.username, ip: r.ip, ua: r.ua },
    r.detail || {}
  ));
}

async function logStats() {
  await ensureSchema();
  const { rows } = await pool.query(`
    SELECT
      count(*) FILTER (WHERE at > now() - interval '24 hours') AS total24,
      count(*) FILTER (WHERE event = 'login_ok' AND at > now() - interval '24 hours') AS logins_ok,
      count(*) FILTER (WHERE event = 'login_fail' AND at > now() - interval '24 hours') AS logins_fail,
      count(*) FILTER (WHERE event LIKE 'export_%' AND at > now() - interval '24 hours') AS exports,
      count(DISTINCT ip) FILTER (WHERE at > now() - interval '24 hours') AS ips,
      (SELECT count(*) FROM vh_access_log) AS total
  `);
  const r = rows[0] || {};
  return {
    total: Number(r.total || 0), loginsOk24h: Number(r.logins_ok || 0),
    loginsFail24h: Number(r.logins_fail || 0), exports24h: Number(r.exports || 0),
    ipsUnicas24h: Number(r.ips || 0),
  };
}

async function bootstrapAdmin() {
  await ensureSchema();
  const { rows } = await pool.query("SELECT 1 FROM vh_users WHERE role = 'admin' LIMIT 1");
  if (rows.length) return null;
  const username = process.env.VH_ADMIN_USER || 'admin';
  const generated = !process.env.VH_ADMIN_PASSWORD;
  const password = process.env.VH_ADMIN_PASSWORD || (crypto.randomBytes(6).toString('hex') + '1a');
  const user = await createUser({ username, password, role: 'admin', nombre: 'Administrador', createdBy: 'bootstrap' });
  await logEvent({ event: 'bootstrap_admin', username, ip: 'local' });
  return { username, password, generated, user };
}

module.exports = {
  backend: 'postgres',
  hashPassword, verifyPassword, validatePassword, validateUsername,
  loadUsers, listUsers, findUser, createUser, updateUser, deleteUser, sanitize,
  authenticate, recordLoginIP,
  logEvent, readLog, logStats,
  bootstrapAdmin,
};
