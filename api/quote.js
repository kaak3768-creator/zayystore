'use strict';
const { handler, send, readJson, requireMethod } = require('../lib/core');
const { priceCart } = require('../lib/catalog');

// Hitung ulang harga keranjang di server (dipakai untuk menampilkan diskon/kode promo).
module.exports = handler(async (req, res) => {
  requireMethod(req, 'POST');
  const body = await readJson(req);
  const p = priceCart(body.items, body.coupon);
  send(res, 200, {
    lines: p.lines.map(({ id, name, price, qty, total }) => ({ id, name, price, qty, total })),
    subtotal: p.subtotal,
    discount: p.discount,
    total: p.total,
    coupon: p.coupon,
    needsUsername: p.needsUsername,
  });
});
