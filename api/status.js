'use strict';
const { handler, send, query, requireMethod, verifyToken } = require('../lib/core');
const { loadTransaction, itemsOf } = require('../lib/orders');
const { fulfill } = require('../lib/fulfill');

// Cek status pembayaran (dipanggil browser tiap beberapa detik). Status diambil dari Kipay, bukan dari browser.
module.exports = handler(async (req, res) => {
  requireMethod(req, 'GET');
  const order = verifyToken(query(req).get('token'));
  const { kp, status } = await loadTransaction(order);

  const base = {
    orderId: order.o,
    status,
    mode: order.m,
    email: order.e,
    username: order.u || null,
    items: itemsOf(order),
    subtotal: order.s,
    discount: order.d,
    total: order.T,
    amount: Number(kp.amount) || order.T,
    expiresAt: order.x,
    createdAt: order.ts,
  };

  if (status === 'mismatch') {
    return send(res, 409, { ...base, status: 'error', error: 'Data pembayaran tidak cocok dengan pesanan. Hubungi admin dengan menyebut ID pesanan.' });
  }
  if (status !== 'paid') return send(res, 200, base);

  const result = await fulfill(order, kp);
  if (result.pending) return send(res, 200, { ...base, status: 'processing' });
  send(res, 200, { ...base, deliveries: result.deliveries });
});
