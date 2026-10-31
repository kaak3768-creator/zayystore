'use strict';
const { kipay, HttpError } = require('./core');
const { PRODUCTS } = require('./catalog');

const normStatus = (s) => {
  s = String(s || '').toLowerCase();
  if (s === 'paid') return 'paid';
  if (['expired', 'failed', 'cancelled', 'canceled'].includes(s)) return 'expired';
  return 'pending';
};

/**
 * Baca transaksi langsung dari Kipay (server-to-server) dan cocokkan dengan pesanan kita.
 * Status "paid" HANYA dipercaya dari sini — tidak pernah dari browser.
 */
async function loadTransaction(order) {
  const kp = await kipay('GET', `/transactions/${encodeURIComponent(order.t)}`);
  if (kp.trx_id && kp.trx_id !== order.t) throw new HttpError(409, 'Transaksi tidak cocok.');
  const status = normStatus(kp.status);

  if (kp.note !== undefined && kp.note !== null && kp.note !== order.o) {
    return { kp, status: 'mismatch' };
  }
  const requested = kp.requested_amount ?? (kp.unique_code != null && kp.amount != null ? kp.amount - kp.unique_code : undefined);
  if (requested !== undefined && Number(requested) !== Number(order.T)) {
    return { kp, status: 'mismatch' };
  }
  return { kp, status };
}

function itemsOf(order) {
  return order.i.map(([id, qty]) => ({ id, name: PRODUCTS[id] ? PRODUCTS[id].name : id, qty }));
}

module.exports = { loadTransaction, itemsOf, normStatus };
