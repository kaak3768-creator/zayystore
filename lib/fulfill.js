'use strict';
/**
 * Pemenuhan pesanan otomatis (idempotent: aman dipanggil berkali-kali oleh webhook & polling status).
 *  - Mode Redis  : stok diambil sekali, hasil disimpan, email & notifikasi admin dikirim sekali.
 *  - Mode tanpa DB: pembeli menerima pesan pengiriman dari katalog (tanpa stok unik, tanpa email).
 */
const store = require('./store');
const { PRODUCTS } = require('./catalog');

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const rupiah = (n) => 'Rp ' + Number(n).toLocaleString('id-ID');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function buildDeliveries(order, useStock) {
  const out = [];
  for (const [id, qty] of order.i) {
    const p = PRODUCTS[id];
    if (!p) continue;
    const d = { productId: id, name: p.name, qty, title: p.delivery.title, message: p.delivery.message, codes: [], manual: false };
    if (p.stock && useStock) {
      for (let n = 0; n < qty; n++) {
        const item = await store.popStock(id);
        if (item) d.codes.push(item);
      }
      if (d.codes.length < qty) {
        d.manual = true; // stok kurang -> admin proses manual
        d.message = p.delivery.fallback || 'Pesanan kamu sedang diproses admin secepatnya.';
      }
    } else if (p.stock) {
      d.manual = true;
      d.message = p.delivery.fallback || p.delivery.message;
    }
    out.push(d);
  }
  return out;
}

/**
 * @param order  payload token pesanan (o, t, e, u, i, T, ...)
 * @param kp     data transaksi dari Kipay (sudah diverifikasi status === 'paid')
 * @returns {{ deliveries: Array, pending?: boolean }}
 */
async function fulfill(order, kp) {
  if (!store.enabled()) {
    return { deliveries: await buildDeliveries(order, false) };
  }

  const doneKey = `zs:done:${order.t}`;
  const existing = await store.getJson(doneKey);
  if (existing) return { deliveries: existing.deliveries };

  const lockKey = `zs:lock:${order.t}`;
  if (!(await store.lock(lockKey, 60))) {
    // proses lain sedang memenuhi pesanan ini — tunggu sebentar lalu baca hasilnya
    for (let i = 0; i < 8; i++) {
      await sleep(400);
      const d = await store.getJson(doneKey);
      if (d) return { deliveries: d.deliveries };
    }
    return { pending: true, deliveries: [] };
  }

  try {
    const again = await store.getJson(doneKey);
    if (again) return { deliveries: again.deliveries };

    const deliveries = await buildDeliveries(order, true);
    await store.setJson(doneKey, { deliveries, paidAt: Date.now(), orderId: order.o, email: order.e });
    // notifikasi dikirim sekali, tidak boleh menggagalkan pesanan
    await notify(order, kp, deliveries).catch((e) => console.error('[notify]', e.message));
    return { deliveries };
  } finally {
    await store.unlock(lockKey).catch(() => {});
  }
}

/* ------------------------------ Notifikasi ------------------------------ */

async function notify(order, kp, deliveries) {
  await Promise.allSettled([sendEmail(order, deliveries), sendDiscord(order, kp, deliveries)]);
}

function deliveryHtml(deliveries) {
  return deliveries.map((d) => `
    <div style="border:1px solid #e1e8f2;border-radius:12px;padding:16px;margin:12px 0">
      <div style="font-weight:700;color:#142744">${esc(d.title)} <span style="color:#71809a;font-weight:500">× ${d.qty}</span></div>
      <p style="color:#455873;font-size:14px;line-height:1.6;margin:8px 0">${esc(d.message)}</p>
      ${d.codes.map((c) => `<pre style="background:#f3f7ff;border-radius:8px;padding:10px 12px;margin:6px 0;font-size:13px;white-space:pre-wrap;word-break:break-all">${esc(c)}</pre>`).join('')}
    </div>`).join('');
}

async function sendEmail(order, deliveries) {
  const key = process.env.RESEND_API_KEY;
  if (!key || !order.e) return;
  const html = `
  <div style="font-family:Inter,Arial,sans-serif;max-width:560px;margin:auto;color:#142744">
    <div style="background:linear-gradient(110deg,#1558dd,#388bff);color:#fff;border-radius:16px 16px 0 0;padding:24px">
      <div style="font-size:12px;letter-spacing:1.5px;opacity:.8">ZAYYSTORE</div>
      <div style="font-size:22px;font-weight:800;margin-top:6px">Pembayaran berhasil ✓</div>
    </div>
    <div style="border:1px solid #e1e8f2;border-top:0;border-radius:0 0 16px 16px;padding:22px">
      <p style="margin:0 0 4px;color:#71809a;font-size:13px">ID Pesanan</p>
      <p style="margin:0 0 14px;font-weight:700">${esc(order.o)}</p>
      ${order.u ? `<p style="margin:0 0 14px;color:#455873;font-size:14px">Username Minecraft: <b>${esc(order.u)}</b></p>` : ''}
      ${deliveryHtml(deliveries)}
      <p style="color:#71809a;font-size:12px;margin-top:18px">Simpan email ini sebagai bukti pembelian. Butuh bantuan? Balas email ini dengan menyebut ID pesanan.</p>
    </div>
  </div>`;
  const r = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      from: process.env.MAIL_FROM || 'ZayyStore <onboarding@resend.dev>',
      to: [order.e],
      subject: `Pesanan ${order.o} berhasil — ZayyStore`,
      html,
      reply_to: process.env.MAIL_REPLY_TO || undefined,
    }),
    signal: AbortSignal.timeout(10000),
  });
  if (!r.ok) throw new Error('Resend ' + r.status);
}

async function sendDiscord(order, kp, deliveries) {
  const hook = process.env.DISCORD_WEBHOOK_URL;
  if (!hook) return;
  const manual = deliveries.some((d) => d.manual);
  const lines = deliveries.map((d) => `• ${d.name} × ${d.qty}${d.manual ? ' ⚠️ PROSES MANUAL' : ''}`).join('\n');
  await fetch(hook, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      embeds: [{
        title: manual ? '⚠️ Pesanan baru — perlu tindakan admin' : '✅ Pesanan baru terbayar',
        color: manual ? 0xf2a400 : 0x1765f5,
        fields: [
          { name: 'ID Pesanan', value: order.o, inline: true },
          { name: 'Total dibayar', value: rupiah(kp.amount || order.T), inline: true },
          { name: 'Email', value: order.e || '-', inline: false },
          ...(order.u ? [{ name: 'Username MC', value: order.u, inline: true }] : []),
          { name: 'Produk', value: lines || '-', inline: false },
        ],
        timestamp: new Date().toISOString(),
      }],
    }),
    signal: AbortSignal.timeout(8000),
  });
}

module.exports = { fulfill, rupiah, esc };
