'use strict';
/**
 * KATALOG PRODUK (sumber kebenaran harga ada di SERVER, bukan di browser).
 * Browser hanya mengirim id + jumlah; harga dihitung ulang di sini sehingga tidak bisa dimanipulasi.
 *
 * Cara tambah produk:
 *  1) tambah entri di PRODUCTS (id harus sama dengan atribut data-id di index.html)
 *  2) pilih cara pengiriman:
 *     - stock: true      -> tiap pembelian mengambil 1 item dari stok (akun/kode/voucher) di Upstash Redis
 *     - tanpa stock      -> pembeli menerima "delivery.message" (instruksi / info proses manual)
 */
const { HttpError } = require('./core');

const PRODUCTS = {
  'acc-java': {
    name: 'Minecraft Java & Bedrock',
    price: 189000,
    stock: true,
    needsUsername: false,
    delivery: {
      title: 'Detail Akun',
      message: 'Detail login akun ada di bawah ini. Segera ganti email & password setelah berhasil login.',
      fallback: 'Detail akun akan dikirim admin ke email kamu secepatnya.',
    },
  },
  'srv-1gb': {
    name: 'Server Minecraft 1GB',
    price: 15000,
    needsUsername: false,
    delivery: {
      title: 'Server Minecraft 1GB',
      message: 'Server kamu sedang disiapkan. Admin akan mengirim IP server & akses panel ke email kamu maksimal 15 menit.',
    },
  },
  'srv-2gb': {
    name: 'Server Minecraft 2GB',
    price: 25000,
    needsUsername: false,
    delivery: {
      title: 'Server Minecraft 2GB',
      message: 'Server kamu sedang disiapkan. Admin akan mengirim IP server & akses panel ke email kamu maksimal 15 menit.',
    },
  },
  'coins': {
    name: 'Minecraft Coins Pack',
    price: 49000,
    stock: true,
    needsUsername: true,
    delivery: {
      title: 'Minecraft Coins',
      message: 'Kode redeem ada di bawah. Tukarkan di minecraft.net/redeem atau di dalam game.',
      fallback: 'Coins akan dikirim admin ke akun kamu secepatnya.',
    },
  },
  'rank-vip': {
    name: 'VIP Rank [30 Hari]',
    price: 20000,
    needsUsername: true,
    delivery: {
      title: 'VIP Rank 30 Hari',
      message: 'Rank VIP akan diaktifkan ke username kamu maksimal 15 menit. Jika belum aktif, hubungi admin dengan menyebut ID pesanan.',
    },
  },
};

/** Kode promo. percent = persen diskon; only = daftar id produk yang berlaku (null = semua). */
const COUPONS = {
  ZAYY20: { percent: 20, label: 'Promo Launch 20%', only: null },
};

const MIN_TOTAL = 1000; // batas minimum nominal transaksi (Rp)
const MAX_QTY = 10;

function priceCart(rawItems, couponCode) {
  if (!Array.isArray(rawItems) || rawItems.length === 0) throw new HttpError(400, 'Keranjang masih kosong.');
  if (rawItems.length > 30) throw new HttpError(400, 'Terlalu banyak item.');

  const merged = new Map();
  for (const it of rawItems) {
    const id = String(it && it.id || '');
    const qty = Number(it && it.qty);
    if (!PRODUCTS[id]) throw new HttpError(400, 'Ada produk yang sudah tidak tersedia. Muat ulang halaman.');
    if (!Number.isInteger(qty) || qty < 1 || qty > MAX_QTY) throw new HttpError(400, `Jumlah per produk maksimal ${MAX_QTY}.`);
    merged.set(id, Math.min(MAX_QTY, (merged.get(id) || 0) + qty));
  }

  const lines = [...merged].map(([id, qty]) => {
    const p = PRODUCTS[id];
    return { id, name: p.name, price: p.price, qty, total: p.price * qty, needsUsername: !!p.needsUsername };
  });
  const subtotal = lines.reduce((s, l) => s + l.total, 0);

  let discount = 0;
  let coupon = null;
  const code = String(couponCode || '').trim().toUpperCase();
  if (code) {
    const c = COUPONS[code];
    if (!c) throw new HttpError(400, 'Kode promo tidak valid.');
    const eligible = lines.filter((l) => !c.only || c.only.includes(l.id)).reduce((s, l) => s + l.total, 0);
    if (eligible <= 0) throw new HttpError(400, 'Kode promo tidak berlaku untuk produk di keranjang.');
    discount = Math.floor((eligible * c.percent) / 100);
    coupon = { code, label: c.label, percent: c.percent };
  }

  const total = subtotal - discount;
  if (total < MIN_TOTAL) throw new HttpError(400, `Total minimal transaksi Rp ${MIN_TOTAL.toLocaleString('id-ID')}.`);

  return { lines, subtotal, discount, total, coupon, needsUsername: lines.some((l) => l.needsUsername) };
}

module.exports = { PRODUCTS, COUPONS, priceCart, MAX_QTY };
