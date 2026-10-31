'use strict';
/**
 * Webhook Kipay  ->  https://DOMAIN-KAMU/api/webhook
 * Verifikasi: HMAC-SHA256( `${timestamp}.${deliveryId}.${rawBody}` , KIPAY_WEBHOOK_SECRET )
 * Lalu transaksi dibaca ulang dari API Kipay sebelum pesanan dipenuhi (sesuai panduan Kipay).
 */
const crypto = require('crypto');
const { readRaw, HttpError, parseKipayTime, handler, send } = require('../lib/core');
const { loadTransaction } = require('../lib/orders');
const { fulfill } = require('../lib/fulfill');
const store = require('../lib/store');

function validSignature(raw, ts, deliveryId, header) {
  const secret = process.env.KIPAY_WEBHOOK_SECRET;
  if (!secret || !header) return false;
  const expected = 'sha256=' + crypto.createHmac('sha256', secret).update(`${ts}.${deliveryId}.`).update(raw).digest('hex');
  const a = Buffer.from(expected);
  const b = Buffer.from(String(header).trim());
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

const plain = (res, status, text) => { res.statusCode = status; res.setHeader('Content-Type', 'text/plain'); res.end(text); };

const main = handler(async (req, res) => {
  if (req.method !== 'POST') return plain(res, 405, 'method not allowed');

  const raw = await readRaw(req);
  const h = req.headers;
  const ts = h['x-webhook-timestamp'];
  const deliveryId = h['x-webhook-delivery'];

  if (!validSignature(raw, ts, deliveryId, h['x-webhook-signature'])) return plain(res, 401, 'invalid signature');

  // Tolak pesan lama (anti-replay), batas 5 menit
  const sentAt = parseKipayTime(/^\d+$/.test(String(ts)) ? Number(ts) : ts);
  if (Number.isFinite(sentAt) && Math.abs(Date.now() - sentAt) > 5 * 60_000) return plain(res, 401, 'timestamp too old');

  let body;
  try { body = JSON.parse(raw.toString('utf8')); } catch { return plain(res, 400, 'bad json'); }
  const event = body.event || h['x-webhook-event'];

  if (event !== 'transaction.paid') return plain(res, 200, 'ok'); // webhook.test / transaction.expired

  const trxId = body.transaction && body.transaction.trx_id;
  if (!trxId) return plain(res, 400, 'missing trx_id');

  if (!store.enabled()) {
    // Tanpa database, detail pesanan tidak tersimpan di server; pemenuhan terjadi saat browser pembeli
    // memeriksa status (api/status). Webhook cukup dikonfirmasi.
    return plain(res, 200, 'ok');
  }

  const order = await store.getJson(`zs:order:${trxId}`);
  if (!order) return plain(res, 200, 'ok'); // bukan transaksi toko ini

  const { kp, status } = await loadTransaction(order);
  if (status !== 'paid') throw new HttpError(409, 'Status belum paid'); // non-2xx -> Kipay akan retry
  await fulfill(order, kp);
  plain(res, 200, 'ok');
});

module.exports = main;
// Penting: body mentah dibutuhkan untuk verifikasi signature.
module.exports.config = { api: { bodyParser: false } };
