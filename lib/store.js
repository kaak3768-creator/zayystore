'use strict';
/**
 * Penyimpanan opsional via Upstash Redis (REST) — gratis & 1-klik lewat Vercel Marketplace.
 * Dipakai untuk: stok akun/kode, pencatatan pesanan, anti-dobel kirim, notifikasi dari webhook.
 * Jika env tidak diisi, toko tetap jalan dalam "mode tanpa database" (lihat README).
 */
const url = () => (process.env.UPSTASH_REDIS_REST_URL || process.env.KV_REST_API_URL || '').replace(/\/$/, '');
const token = () => process.env.UPSTASH_REDIS_REST_TOKEN || process.env.KV_REST_API_TOKEN || '';

const enabled = () => !!(url() && token());

async function cmd(...args) {
  const r = await fetch(url(), {
    method: 'POST',
    headers: { Authorization: `Bearer ${token()}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(args),
    signal: AbortSignal.timeout(8000),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || j.error) throw new Error('Redis: ' + (j.error || r.status));
  return j.result;
}

const DAY = 86400;

module.exports = {
  enabled,
  async getJson(key) { const v = await cmd('GET', key); return v ? JSON.parse(v) : null; },
  async setJson(key, value, ttlSec = 90 * DAY) { return cmd('SET', key, JSON.stringify(value), 'EX', ttlSec); },
  /** true jika berhasil mengunci (belum ada) */
  async lock(key, ttlSec = 60) { return (await cmd('SET', key, '1', 'NX', 'EX', ttlSec)) === 'OK'; },
  async unlock(key) { return cmd('DEL', key); },
  async popStock(productId) { return cmd('LPOP', `zs:stock:${productId}`); },
  async pushStock(productId, items) { return cmd('RPUSH', `zs:stock:${productId}`, ...items); },
  async stockCount(productId) { return Number(await cmd('LLEN', `zs:stock:${productId}`)) || 0; },
};
