'use strict';
/* =============================================================================
 * store.js — Usuarios, contraseñas y registro de accesos
 * =============================================================================
 * Persistencia en archivos JSON dentro de ./data. Sin base de datos externa,
 * para que el despliegue no requiera montar nada más.
 *
 * Contraseñas: nunca se guardan en texto plano. Se guarda scrypt(clave, sal)
 * con sal distinta por usuario. No hay forma de recuperar una contraseña
 * olvidada: el administrador la restablece (asigna una nueva).
 * ========================================================================== */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const DATA_DIR = process.env.VH_DATA_DIR || path.join(__dirname, 'data');
const USERS_FILE = path.join(DATA_DIR, 'users.json');
const LOG_FILE = path.join(DATA_DIR, 'access.log.jsonl');

const MAX_LOG_ENTRIES = 5000; // se recorta el archivo cuando lo supera

function ensureDir() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
}

// --------------------------------------------------------------------------
// Contraseñas
// --------------------------------------------------------------------------
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

// Requisitos mínimos de contraseña. Deliberadamente modestos: una regla muy
// estricta empuja a la gente a anotar la clave en un papel.
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

// --------------------------------------------------------------------------
// Usuarios
// --------------------------------------------------------------------------
function loadUsers() {
  ensureDir();
  if (!fs.existsSync(USERS_FILE)) return [];
  try {
    const raw = JSON.parse(fs.readFileSync(USERS_FILE, 'utf8'));
    return Array.isArray(raw) ? raw : [];
  } catch (e) {
    console.error('  ⚠ users.json ilegible; se usa lista vacía:', e.message);
    return [];
  }
}
function saveUsers(users) {
  ensureDir();
  // escritura atómica: primero a un temporal, después rename. Evita dejar el
  // archivo a medio escribir si el proceso muere en el medio.
  const tmp = USERS_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(users, null, 2), 'utf8');
  fs.renameSync(tmp, USERS_FILE);
}
function findUser(username) {
  const u = String(username || '').trim().toLowerCase();
  return loadUsers().find((x) => x.username.toLowerCase() === u) || null;
}

function createUser({ username, password, role = 'user', nombre = '', email = '', createdBy = 'sistema' }) {
  const uErr = validateUsername(username);
  if (uErr) throw new Error(uErr);
  const pErr = validatePassword(password);
  if (pErr) throw new Error(pErr);
  if (findUser(username)) throw new Error('Ya existe un usuario con ese nombre.');
  if (!['admin', 'user'].includes(role)) throw new Error('Rol inválido.');

  const users = loadUsers();
  const user = {
    id: crypto.randomUUID(),
    username: String(username).trim(),
    nombre: String(nombre || '').slice(0, 80),
    email: String(email || '').slice(0, 120),
    role,
    passwordHash: hashPassword(password),
    active: true,
    mustChangePassword: true, // la clave la puso el admin: el usuario la cambia al entrar
    createdAt: new Date().toISOString(),
    createdBy,
    lastLoginAt: null,
    lastLoginIP: null,
    loginCount: 0,
    failedAttempts: 0,
    lockedUntil: null,
  };
  users.push(user);
  saveUsers(users);
  return sanitize(user);
}

function updateUser(id, patch, actor = 'sistema') {
  const users = loadUsers();
  const i = users.findIndex((u) => u.id === id);
  if (i < 0) throw new Error('Usuario inexistente.');
  const u = users[i];

  if (patch.nombre !== undefined) u.nombre = String(patch.nombre).slice(0, 80);
  if (patch.email !== undefined) u.email = String(patch.email).slice(0, 120);
  if (patch.role !== undefined) {
    if (!['admin', 'user'].includes(patch.role)) throw new Error('Rol inválido.');
    // No permitir quedarse sin ningún administrador activo
    if (u.role === 'admin' && patch.role !== 'admin' && countActiveAdmins(users, u.id) === 0) {
      throw new Error('No se puede quitar el último administrador activo.');
    }
    u.role = patch.role;
  }
  if (patch.active !== undefined) {
    const next = !!patch.active;
    if (u.role === 'admin' && !next && countActiveAdmins(users, u.id) === 0) {
      throw new Error('No se puede desactivar el último administrador activo.');
    }
    u.active = next;
    if (next) { u.failedAttempts = 0; u.lockedUntil = null; }
  }
  if (patch.password) {
    const pErr = validatePassword(patch.password);
    if (pErr) throw new Error(pErr);
    u.passwordHash = hashPassword(patch.password);
    u.mustChangePassword = patch.mustChangePassword !== false;
    u.failedAttempts = 0;
    u.lockedUntil = null;
    u.passwordChangedAt = new Date().toISOString();
    u.passwordChangedBy = actor;
  }
  u.updatedAt = new Date().toISOString();
  u.updatedBy = actor;
  users[i] = u;
  saveUsers(users);
  return sanitize(u);
}

function countActiveAdmins(users, excludeId) {
  return users.filter((x) => x.role === 'admin' && x.active && x.id !== excludeId).length;
}

function deleteUser(id) {
  const users = loadUsers();
  const u = users.find((x) => x.id === id);
  if (!u) throw new Error('Usuario inexistente.');
  if (u.role === 'admin' && countActiveAdmins(users, u.id) === 0) {
    throw new Error('No se puede eliminar el último administrador activo.');
  }
  saveUsers(users.filter((x) => x.id !== id));
  return true;
}

function sanitize(u) {
  const { passwordHash, ...rest } = u;
  return rest;
}
function listUsers() {
  return loadUsers().map(sanitize);
}

// --------------------------------------------------------------------------
// Autenticación (con bloqueo por intentos fallidos, por usuario)
// --------------------------------------------------------------------------
const MAX_FAILED = 5;
const LOCK_MS = 1000 * 60 * 15;

function authenticate(username, password) {
  const users = loadUsers();
  const i = users.findIndex((x) => x.username.toLowerCase() === String(username || '').trim().toLowerCase());
  if (i < 0) return { ok: false, reason: 'credenciales' };
  const u = users[i];

  if (!u.active) return { ok: false, reason: 'inactivo' };
  if (u.lockedUntil && Date.now() < new Date(u.lockedUntil).getTime()) {
    return { ok: false, reason: 'bloqueado', lockedUntil: u.lockedUntil };
  }

  if (!verifyPassword(password, u.passwordHash)) {
    u.failedAttempts = (u.failedAttempts || 0) + 1;
    if (u.failedAttempts >= MAX_FAILED) {
      u.lockedUntil = new Date(Date.now() + LOCK_MS).toISOString();
      u.failedAttempts = 0;
    }
    users[i] = u;
    saveUsers(users);
    return { ok: false, reason: u.lockedUntil && Date.now() < new Date(u.lockedUntil).getTime() ? 'bloqueado' : 'credenciales', lockedUntil: u.lockedUntil };
  }

  u.failedAttempts = 0;
  u.lockedUntil = null;
  u.lastLoginAt = new Date().toISOString();
  u.loginCount = (u.loginCount || 0) + 1;
  users[i] = u;
  saveUsers(users);
  return { ok: true, user: sanitize(u) };
}

function recordLoginIP(id, ip) {
  const users = loadUsers();
  const i = users.findIndex((x) => x.id === id);
  if (i < 0) return;
  users[i].lastLoginIP = ip;
  saveUsers(users);
}

// --------------------------------------------------------------------------
// Registro de accesos y acciones (auditoría)
// --------------------------------------------------------------------------
function logEvent(evt) {
  ensureDir();
  const entry = Object.assign({ at: new Date().toISOString() }, evt);
  try {
    fs.appendFileSync(LOG_FILE, JSON.stringify(entry) + '\n', 'utf8');
    trimLogIfNeeded();
  } catch (e) {
    console.error('  ⚠ no se pudo escribir el registro de accesos:', e.message);
  }
  return entry;
}
function trimLogIfNeeded() {
  try {
    const lines = fs.readFileSync(LOG_FILE, 'utf8').split('\n').filter(Boolean);
    if (lines.length > MAX_LOG_ENTRIES) {
      const keep = lines.slice(-Math.floor(MAX_LOG_ENTRIES * 0.8));
      fs.writeFileSync(LOG_FILE, keep.join('\n') + '\n', 'utf8');
    }
  } catch (_) {}
}
function readLog({ limit = 200, username = null, event = null } = {}) {
  ensureDir();
  if (!fs.existsSync(LOG_FILE)) return [];
  let lines;
  try { lines = fs.readFileSync(LOG_FILE, 'utf8').split('\n').filter(Boolean); }
  catch (_) { return []; }
  const out = [];
  for (let i = lines.length - 1; i >= 0 && out.length < limit; i--) {
    try {
      const e = JSON.parse(lines[i]);
      if (username && String(e.username || '').toLowerCase() !== String(username).toLowerCase()) continue;
      if (event && e.event !== event) continue;
      out.push(e);
    } catch (_) {}
  }
  return out;
}
function logStats() {
  const all = readLog({ limit: MAX_LOG_ENTRIES });
  const now = Date.now();
  const last24 = all.filter((e) => now - new Date(e.at).getTime() < 86400000);
  return {
    total: all.length,
    loginsOk24h: last24.filter((e) => e.event === 'login_ok').length,
    loginsFail24h: last24.filter((e) => e.event === 'login_fail').length,
    exports24h: last24.filter((e) => String(e.event || '').startsWith('export_')).length,
    ipsUnicas24h: [...new Set(last24.map((e) => e.ip).filter(Boolean))].length,
  };
}

// --------------------------------------------------------------------------
// Arranque: garantiza que exista un administrador
// --------------------------------------------------------------------------
function bootstrapAdmin() {
  const users = loadUsers();
  if (users.some((u) => u.role === 'admin')) return null;
  const username = process.env.VH_ADMIN_USER || 'admin';
  // Si no se define una clave, se genera una aleatoria y se muestra UNA vez
  // por consola. Es mejor que dejar "admin/admin" funcionando para siempre.
  const generated = !process.env.VH_ADMIN_PASSWORD;
  const password = process.env.VH_ADMIN_PASSWORD || (crypto.randomBytes(6).toString('hex') + '1a');
  const user = createUser({ username, password, role: 'admin', nombre: 'Administrador', createdBy: 'bootstrap' });
  logEvent({ event: 'bootstrap_admin', username, ip: 'local' });
  return { username, password, generated, user };
}

module.exports = {
  DATA_DIR, USERS_FILE, LOG_FILE,
  hashPassword, verifyPassword, validatePassword, validateUsername,
  loadUsers, listUsers, findUser, createUser, updateUser, deleteUser, sanitize,
  authenticate, recordLoginIP,
  logEvent, readLog, logStats,
  bootstrapAdmin,
};
