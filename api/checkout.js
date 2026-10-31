'use strict';
const crypto = require('crypto');
const { handler, send, readJson, requireMethod, HttpError, kipay, signToken, parseKipayTime } = require('../lib/core');
const { priceCart, PRODUCTS } = require('../lib/catalog');
const store = require('../lib/store');

const EMAIL_RE = /^[^\s@]{1,64}@[^\s@]{1,255}\.[^\s@]{2,}$/;
const USER_RE = /^[A-Za-z0-9_ .]{3,24}$/;

function newOrderId() {
  return 'ZS-' + Date.now().toString(36).toUpperCase().slice(-6) + crypto.randomBytes(2).toString('hex').toUpperCase();
}

// Buat pesanan + transaksi QRIS di Kipay.
module.exports = handler(async (req, res) => {
  requireMethod(req, 'POST');
  const body = await readJson(req);

  const email = String(body.email || '').trim().toLowerCase();
  if (!EMAIL_RE.test(email)) throw new HttpError(400, 'Email tidak valid.');

  const cart = priceCart(body.items, body.coupon);

  const username = String(body.username || '').trim();
  if (cart.needsUsername && !USER_RE.test(username)) {
    throw new HttpError(400, 'Username Minecraft wajib diisi (3–24 karakter: huruf, angka, _ . spasi).');
  }
  if (username && !USER_RE.test(username)) throw new HttpError(400, 'Username Minecraft tidak valid.');

  // Cek stok untuk produk bertipe stok (hanya jika Redis aktif)
  if (store.enabled()) {
    for (const l of cart.lines) {
      if (PRODUCTS[l.id].stock && (await store.stockCount(l.id)) < l.qty) {
        throw new HttpError(409, `Stok "${l.name}" tidak mencukupi saat ini.`);
      }
    }
  }

  const orderId = newOrderId();
  const kp = await kipay('POST', '/transactions', { amount: cart.total, note: orderId });
  if (!kp.trx_id) throw new HttpError(502, 'Respons payment gateway tidak lengkap.');

  const mode = kp.mode || (String(kp.trx_id).startsWith('SBX') ? 'sandbox' : 'live');

  // Waktu kedaluwarsa (Kipay mengirim UTC). Jika tidak masuk akal, pakai 15 menit.
  const now = Date.now();
  let expiresAt = parseKipayTime(kp.expires_at);
  if (!Number.isFinite(expiresAt) || expiresAt - now < 60_000 || expiresAt - now > 6 * 3600_000) {
    expiresAt = now + 15 * 60_000;
  }

  const order = {
    v: 1,
    o: orderId,
    t: kp.trx_id,
    e: email,
    u: username || undefined,
    i: cart.lines.map((l) => [l.id, l.qty]),
    c: cart.coupon ? cart.coupon.code : undefined,
    s: cart.subtotal,
    d: cart.discount,
    T: cart.total,
    m: mode,
    ts: now,
    x: expiresAt,
  };

  if (store.enabled()) await store.setJson(`zs:order:${order.t}`, order, 30 * 86400);

  send(res, 200, {
    token: signToken(order),
    orderId,
    trxId: kp.trx_id,
    mode,
    total: cart.total,
    amount: Number(kp.amount) || cart.total, // nominal yang harus dibayar (sudah termasuk kode unik)
    uniqueCode: Number(kp.unique_code) || 0,
    expiresAt,
  });
});
