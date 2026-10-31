'use strict';
const { handler, query, requireMethod, verifyToken, kipayQr } = require('../lib/core');

// Proxy gambar QR: API key Kipay tidak pernah sampai ke browser.
module.exports = handler(async (req, res) => {
  requireMethod(req, 'GET');
  const order = verifyToken(query(req).get('token'));
  const png = await kipayQr(order.t);
  res.statusCode = 200;
  res.setHeader('Content-Type', 'image/png');
  res.setHeader('Cache-Control', 'private, max-age=60');
  res.end(png);
});
