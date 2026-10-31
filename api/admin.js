'use strict';
/**
 * Endpoint admin kecil untuk mengelola stok (butuh env ADMIN_TOKEN + Redis).
 *   GET  /api/admin?action=stock                      -> jumlah stok tiap produk
 *   POST /api/admin {action:"add-stock", productId, items:["email:pass", ...]}
 *   GET  /api/admin?action=order&trx=TRX_ID           -> detail pengiriman pesanan
 * Header: Authorization: Bearer <ADMIN_TOKEN>
 */
const crypto = require('crypto');
const { handler, send, readJson, query, HttpError } = require('../lib/core');
const { PRODUCTS } = require('../lib/catalog');
const store = require('../lib/store');

function authed(req) {
  const t = process.env.ADMIN_TOKEN;
  const got = String(req.headers.authorization || '').replace(/^Bearer\s+/i, '');
  if (!t || t.length < 16) return false;
  const a = crypto.createHash('sha256').update(got).digest();
  const b = crypto.createHash('sha256').update(t).digest();
  return crypto.timingSafeEqual(a, b);
}

module.exports = handler(async (req, res) => {
  if (!authed(req)) throw new HttpError(401, 'Unauthorized');
  if (!store.enabled()) throw new HttpError(503, 'Redis belum dikonfigurasi.');

  if (req.method === 'GET') {
    const q = query(req);
    if (q.get('action') === 'order') {
      return send(res, 200, { order: await store.getJson(`zs:order:${q.get('trx')}`), done: await store.getJson(`zs:done:${q.get('trx')}`) });
    }
    const stock = {};
    for (const id of Object.keys(PRODUCTS)) if (PRODUCTS[id].stock) stock[id] = await store.stockCount(id);
    return send(res, 200, { stock });
  }

  if (req.method === 'POST') {
    const b = await readJson(req);
    if (b.action !== 'add-stock') throw new HttpError(400, 'Aksi tidak dikenal.');
    if (!PRODUCTS[b.productId] || !PRODUCTS[b.productId].stock) throw new HttpError(400, 'Produk tidak bertipe stok.');
    const items = (Array.isArray(b.items) ? b.items : []).map((s) => String(s).trim()).filter(Boolean);
    if (!items.length || items.length > 500) throw new HttpError(400, 'items kosong / terlalu banyak.');
    await store.pushStock(b.productId, items);
    return send(res, 200, { ok: true, added: items.length, stock: await store.stockCount(b.productId) });
  }

  throw new HttpError(405, 'Method tidak diizinkan');
});
