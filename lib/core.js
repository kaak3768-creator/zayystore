'use strict';
/**
 * Helper inti: response JSON, error, token pesanan bertanda-tangan, dan klien API Kipay.
 * Semua rahasia (API key, secret) hanya dibaca dari environment variable di server.
 */
const crypto = require('crypto');

class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

function send(res, status, body, headers = {}) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  for (const [k, v] of Object.entries(headers)) res.setHeader(k, v);
  res.end(JSON.stringify(body));
}

/** Bungkus handler agar error selalu jadi JSON rapi (tanpa membocorkan detail internal). */
function handler(fn) {
  return async (req, res) => {
    try {
      await fn(req, res);
    } catch (e) {
      if (e instanceof HttpError) return send(res, e.status, { error: e.message });
      console.error('[unhandled]', e && e.stack ? e.stack : e);
      send(res, 500, { error: 'Terjadi kesalahan pada server. Coba lagi sebentar.' });
    }
  };
}

function readStream(req, limit = 100 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) { reject(new HttpError(413, 'Permintaan terlalu besar')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

/** Ambil body mentah (dipakai webhook untuk verifikasi signature). */
async function readRaw(req) {
  if (Buffer.isBuffer(req.body)) return req.body;
  if (typeof req.body === 'string') return Buffer.from(req.body);
  return readStream(req);
}

async function readJson(req) {
  if (req.body && typeof req.body === 'object' && !Buffer.isBuffer(req.body)) return req.body;
  const raw = await readRaw(req);
  if (!raw.length) return {};
  try { return JSON.parse(raw.toString('utf8')); }
  catch { throw new HttpError(400, 'Format permintaan tidak valid'); }
}

function query(req) {
  return new URL(req.url, 'http://localhost').searchParams;
}

function requireMethod(req, ...methods) {
  if (!methods.includes(req.method)) throw new HttpError(405, 'Method tidak diizinkan');
}

/* ---------------------------- Token pesanan ---------------------------- */

function secret() {
  if (process.env.ORDER_SECRET) return process.env.ORDER_SECRET;
  // Fallback agar tetap aman bila ORDER_SECRET belum diisi (diturunkan dari API key).
  return crypto.createHash('sha256').update('zayystore|' + (process.env.KIPAY_API_KEY || '')).digest('hex');
}

function signToken(payload) {
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const sig = crypto.createHmac('sha256', secret()).update(body).digest('base64url');
  return `${body}.${sig}`;
}

function verifyToken(token) {
  if (typeof token !== 'string' || token.length > 4000 || !token.includes('.')) {
    throw new HttpError(400, 'Token pesanan tidak valid');
  }
  const [body, sig] = token.split('.');
  const expected = crypto.createHmac('sha256', secret()).update(body).digest('base64url');
  const a = Buffer.from(sig || '');
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) throw new HttpError(400, 'Token pesanan tidak valid');
  try { return JSON.parse(Buffer.from(body, 'base64url').toString('utf8')); }
  catch { throw new HttpError(400, 'Token pesanan tidak valid'); }
}

/* ------------------------------ Klien Kipay ----------------------------- */

const kipayBase = () => (process.env.KIPAY_BASE_URL || 'https://api.kipay.id').replace(/\/$/, '');

function kipayUrl(path) {
  const key = process.env.KIPAY_API_KEY;
  if (!key) throw new HttpError(500, 'Pembayaran belum dikonfigurasi (KIPAY_API_KEY belum diisi di Vercel).');
  return `${kipayBase()}/api/pay/${encodeURIComponent(key)}${path}`;
}

async function kipay(method, path, body) {
  const url = kipayUrl(path); // jangan pernah di-log: berisi API key
  let r;
  try {
    r = await fetch(url, {
      method,
      headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(15000),
    });
  } catch (e) {
    console.error('[kipay] network error:', e.message);
    throw new HttpError(502, 'Gagal terhubung ke payment gateway. Coba lagi sebentar.');
  }
  const text = await r.text();
  let data = null;
  try { data = JSON.parse(text); } catch { /* bukan JSON */ }
  if (!r.ok) {
    console.error('[kipay]', method, path.replace(/\/[A-Za-z0-9-]+(?=\/|$)/g, '/*'), '->', r.status, text.slice(0, 300));
    throw new HttpError(r.status === 404 ? 404 : 502, `Payment gateway menolak permintaan (${r.status}).`);
  }
  return data || {};
}

async function kipayQr(trxId) {
  const url = kipayUrl(`/transactions/${encodeURIComponent(trxId)}/qr.png`);
  let r;
  try { r = await fetch(url, { headers: { Accept: 'image/png' }, signal: AbortSignal.timeout(15000) }); }
  catch { throw new HttpError(502, 'Gagal mengambil QR'); }
  if (!r.ok) throw new HttpError(404, 'QR tidak tersedia / sudah kedaluwarsa');
  return Buffer.from(await r.arrayBuffer());
}

/** Kipay mengirim waktu "YYYY-MM-DD HH:mm:ss" dalam UTC (sama dengan sent_at webhook). */
function parseKipayTime(s) {
  if (!s) return NaN;
  if (typeof s === 'number') return s > 1e12 ? s : s * 1000;
  const str = String(s).trim();
  if (/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(str)) return Date.parse(str.replace(' ', 'T') + 'Z');
  return Date.parse(str);
}

module.exports = {
  HttpError, send, handler, readRaw, readJson, query, requireMethod,
  signToken, verifyToken, kipay, kipayQr, parseKipayTime, secret,
};
