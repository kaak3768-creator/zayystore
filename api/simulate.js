'use strict';
const { handler, send, readJson, requireMethod, verifyToken, kipay, HttpError } = require('../lib/core');

// Khusus SANDBOX: simulasi "pembayaran berhasil" untuk uji coba. Otomatis ditolak untuk transaksi live.
module.exports = handler(async (req, res) => {
  requireMethod(req, 'POST');
  const { token } = await readJson(req);
  const order = verifyToken(token);
  if (order.m !== 'sandbox') throw new HttpError(403, 'Simulasi hanya tersedia di mode sandbox.');
  await kipay('POST', `/transactions/${encodeURIComponent(order.t)}/simulate`, { provider: 'shopeepay' });
  send(res, 200, { ok: true });
});
