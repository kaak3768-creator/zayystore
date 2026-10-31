#!/usr/bin/env node
'use strict';
/**
 * Server lokal untuk uji coba TANPA internet/akun Kipay:  npm run dev   ->  http://localhost:3000
 *  - menyajikan file statis + semua fungsi di /api (mirip Vercel)
 *  - menjalankan MOCK Kipay (sandbox) & MOCK Redis di port 4010
 *    (QR mock hanya gambar contoh, tidak bisa discan — hanya untuk cek tampilan/alur)
 * Untuk uji dengan Kipay sungguhan: jalankan dengan `npm run dev:real` (butuh .env.local berisi KIPAY_API_KEY).
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const crypto = require('crypto');

const ROOT = path.join(__dirname, '..');
const PORT = Number(process.env.PORT || 3000);
const MOCK = !process.argv.includes('--real');

// .env.local sederhana
for (const f of ['.env.local', '.env']) {
  const p = path.join(ROOT, f);
  if (fs.existsSync(p)) for (const line of fs.readFileSync(p, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/); if (m && !(m[1] in process.env)) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
}

/* ------------------------------ MOCK ------------------------------ */
function startMock() {
  const MOCK_PORT = 4010;
  const WEBHOOK_SECRET = 'whsec_mocksecretmocksecretmocksecretmocksecretmock';
  process.env.KIPAY_BASE_URL = `http://localhost:${MOCK_PORT}`;
  process.env.KIPAY_API_KEY = process.env.KIPAY_API_KEY || 'apg_mock_key';
  process.env.KIPAY_WEBHOOK_SECRET = WEBHOOK_SECRET;
  if (!process.env.MOCK_NO_REDIS) process.env.UPSTASH_REDIS_REST_URL = process.env.UPSTASH_REDIS_REST_URL || `http://localhost:${MOCK_PORT}/redis`;
  process.env.UPSTASH_REDIS_REST_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN || 'mock';
  process.env.ADMIN_TOKEN = process.env.ADMIN_TOKEN || 'admin-token-for-local-testing';

  const txs = new Map();
  const kv = new Map(); // string | array
  const exp = new Map();
  const now = () => new Date().toISOString().slice(0, 19).replace('T', ' ');

  // PNG 500x500 berisi pola mirip QR (hanya untuk tampilan)
  function fakeQr() {
    const N = 25, S = 20, W = N * S;
    const rows = [];
    let seed = 7; const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
    const finder = (x, y, cx, cy) => { const dx = Math.abs(x - cx), dy = Math.abs(y - cy), d = Math.max(dx, dy); return d <= 3 && (d === 3 || d <= 1 || false) ? d !== 2 : null; };
    const cell = (x, y) => {
      for (const [cx, cy] of [[3, 3], [N - 4, 3], [3, N - 4]]) {
        const d = Math.max(Math.abs(x - cx), Math.abs(y - cy));
        if (d <= 3) return d !== 2;
        if (d === 4) return false;
      }
      return rnd() > 0.5;
    };
    const grid = Array.from({ length: N }, (_, y) => Array.from({ length: N }, (_, x) => cell(x, y)));
    for (let y = 0; y < W; y++) {
      const row = Buffer.alloc(1 + W * 3); row[0] = 0;
      for (let x = 0; x < W; x++) { const v = grid[Math.floor(y / S)][Math.floor(x / S)] ? 20 : 255; row[1 + x * 3] = v; row[2 + x * 3] = v; row[3 + x * 3] = v; }
      rows.push(row);
    }
    const crcT = []; for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; crcT[n] = c >>> 0; }
    const crc = (b) => { let c = 0xffffffff; for (const x of b) c = crcT[(c ^ x) & 255] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
    const chunk = (t, d) => { const l = Buffer.alloc(4); l.writeUInt32BE(d.length); const td = Buffer.concat([Buffer.from(t), d]); const c = Buffer.alloc(4); c.writeUInt32BE(crc(td)); return Buffer.concat([l, td, c]); };
    const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(W, 0); ihdr.writeUInt32BE(W, 4); ihdr[8] = 8; ihdr[9] = 2;
    return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(Buffer.concat(rows))), chunk('IEND', Buffer.alloc(0))]);
  }
  const QR = fakeQr();

  async function sendWebhook(tx) {
    const hook = process.env.MOCK_WEBHOOK_URL || `http://localhost:${PORT}/api/webhook`;
    const body = JSON.stringify({ event: 'transaction.paid', sent_at: new Date().toISOString(), transaction: { ...tx, net_amount: tx.amount - 100, fee_bearer: 'merchant' } });
    const ts = String(Math.floor(Date.now() / 1000)), id = 'dlv_' + crypto.randomBytes(6).toString('hex');
    const sig = 'sha256=' + crypto.createHmac('sha256', WEBHOOK_SECRET).update(`${ts}.${id}.${body}`).digest('hex');
    try {
      const r = await fetch(hook, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Webhook-Event': 'transaction.paid', 'X-Webhook-Delivery': id, 'X-Webhook-Timestamp': ts, 'X-Webhook-Signature': sig }, body });
      console.log('[mock-kipay] webhook ->', r.status);
    } catch (e) { console.log('[mock-kipay] webhook gagal', e.message); }
  }

  http.createServer(async (req, res) => {
    const chunks = []; for await (const c of req) chunks.push(c);
    const raw = Buffer.concat(chunks).toString();
    const u = new URL(req.url, 'http://x');
    const json = (s, o) => { res.writeHead(s, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(o)); };

    if (u.pathname === '/redis') { // Upstash REST
      const [c, ...a] = JSON.parse(raw); const k = a[0];
      if (exp.has(k) && exp.get(k) < Date.now()) { kv.delete(k); exp.delete(k); }
      switch (c) {
        case 'GET': return json(200, { result: kv.get(k) ?? null });
        case 'SET': { if (a.includes('NX') && kv.has(k)) return json(200, { result: null }); kv.set(k, a[1]); const i = a.indexOf('EX'); if (i > 0) exp.set(k, Date.now() + a[i + 1] * 1000); return json(200, { result: 'OK' }); }
        case 'DEL': kv.delete(k); return json(200, { result: 1 });
        case 'RPUSH': { const l = kv.get(k) || []; l.push(...a.slice(1)); kv.set(k, l); return json(200, { result: l.length }); }
        case 'LPOP': { const l = kv.get(k) || []; return json(200, { result: l.shift() ?? null }); }
        case 'LLEN': return json(200, { result: (kv.get(k) || []).length });
        default: return json(200, { error: 'unsupported ' + c });
      }
    }

    const m = u.pathname.match(/^\/api\/pay\/([^/]+)\/transactions(?:\/([^/]+))?(?:\/(qr\.png|simulate))?$/);
    if (!m) return json(404, { error: 'not found' });
    const [, key, id, action] = m;
    if (key !== process.env.KIPAY_API_KEY) return json(401, { error: 'invalid key' });

    if (req.method === 'POST' && !id) {
      const b = JSON.parse(raw); const uc = 100 + Math.floor(Math.random() * 899);
      const trx_id = 'SBX-' + new Date().toISOString().slice(0, 10).replace(/-/g, '') + '-' + crypto.randomBytes(3).toString('hex').toUpperCase();
      const tx = { trx_id, mode: 'sandbox', requested_amount: b.amount, unique_code: uc, amount: b.amount + uc, fee_amount: Math.round(b.amount * .01), fee_bearer: 'merchant', status: 'pending', provider: null, note: b.note, qr_payload: '000201...', created_at: now(), expires_at: new Date(Date.now() + (Number(process.env.MOCK_TTL_MIN) || 15) * 60000).toISOString().slice(0, 19).replace('T', ' ') };
      txs.set(trx_id, tx); return json(201, tx);
    }
    const tx = txs.get(id);
    if (!tx) { res.writeHead(404, { 'Content-Type': 'text/plain' }); return res.end('not found'); }
    if (req.method === 'GET' && action === 'qr.png') { res.writeHead(200, { 'Content-Type': 'image/png' }); return res.end(QR); }
    if (req.method === 'POST' && action === 'simulate') {
      tx.status = 'paid'; tx.provider = 'shopeepay'; tx.matched_at = now();
      setTimeout(() => sendWebhook(tx), 300);
      return json(200, { status: 'paid', matched_at: tx.matched_at });
    }
    if (req.method === 'GET') {
      if (tx.status === 'pending' && Date.parse(tx.expires_at.replace(' ', 'T') + 'Z') < Date.now()) tx.status = 'expired';
      return json(200, tx);
    }
    json(405, { error: 'method' });
  }).listen(MOCK_PORT, () => console.log(`[mock] Kipay + Redis palsu aktif di :${MOCK_PORT}  (mode uji — bukan pembayaran sungguhan)`));
}

if (MOCK) startMock();

/* --------------------------- server utama --------------------------- */
const TYPES = { '.html': 'text/html; charset=utf-8', '.css': 'text/css', '.js': 'text/javascript', '.svg': 'image/svg+xml', '.jpg': 'image/jpeg', '.png': 'image/png', '.json': 'application/json', '.ico': 'image/x-icon' };

http.createServer(async (req, res) => {
  const u = new URL(req.url, 'http://localhost');
  if (u.pathname.startsWith('/api/')) {
    const name = u.pathname.slice(5).replace(/[^a-z0-9-]/gi, '');
    const file = path.join(ROOT, 'api', name + '.js');
    if (!fs.existsSync(file)) { res.statusCode = 404; return res.end('{"error":"not found"}'); }
    const mod = require(file);
    // meniru Vercel: body JSON di-parse otomatis kecuali bodyParser:false
    if (!(mod.config && mod.config.api && mod.config.api.bodyParser === false) && ['POST', 'PUT', 'PATCH'].includes(req.method)) {
      const chunks = []; for await (const c of req) chunks.push(c);
      const raw = Buffer.concat(chunks).toString();
      try { req.body = raw ? JSON.parse(raw) : {}; } catch { req.body = raw; }
    }
    return mod(req, res);
  }
  let p = decodeURIComponent(u.pathname); if (p === '/') p = '/index.html';
  const f = path.normalize(path.join(ROOT, p));
  const blocked = /^(\/(api|lib|scripts|node_modules)\/|\/\.|\/package|\/vercel|\/README)/;
  if (!f.startsWith(ROOT) || blocked.test(p) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) { res.statusCode = 404; return res.end('Not found'); }
  res.setHeader('Content-Type', TYPES[path.extname(f)] || 'application/octet-stream');
  fs.createReadStream(f).pipe(res);
}).listen(PORT, () => console.log(`ZayyStore dev  ->  http://localhost:${PORT}${MOCK ? '   (mode MOCK)' : '   (Kipay sungguhan)'}`));
