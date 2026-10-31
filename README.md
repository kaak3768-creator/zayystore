# ZayyStore — pembayaran & pembelian otomatis (QRIS via Kipay) di Vercel

## Alur otomatis
1. Pembeli pilih produk → keranjang (+ kode promo `ZAYY20`) → isi email (& username Minecraft bila perlu)
2. Server membuat transaksi di Kipay → tampil **QRIS + nominal + hitung mundur**
3. Pembeli bayar → Kipay kirim **webhook** → server verifikasi signature & cek ulang status ke Kipay
4. Produk **otomatis dikirim**: tampil di layar, dikirim ke email, dan admin dapat notifikasi Discord

Harga **selalu dihitung ulang di server** (`lib/catalog.js`), API key tidak pernah ke browser.

## Setup (±10 menit)

### 1. Deploy ke Vercel
Upload folder ini ke GitHub → Vercel → *Add New Project* → pilih repo (Framework: **Other**, tanpa build command).

### 2. Environment Variables (Vercel → Settings → Environment Variables)
| Nama | Isi |
|---|---|
| `KIPAY_API_KEY` | API key project Kipay (`apg_...`) |
| `KIPAY_WEBHOOK_SECRET` | secret `whsec_...` (lihat langkah 3) |
| `ORDER_SECRET` | teks acak panjang (`openssl rand -hex 32`) |
| `UPSTASH_REDIS_REST_URL` / `_TOKEN` | otomatis terisi bila kamu tambah **Storage → Upstash Redis** (gratis) |
| `RESEND_API_KEY`, `MAIL_FROM` | opsional, email otomatis ke pembeli (resend.com) |
| `DISCORD_WEBHOOK_URL` | opsional, notifikasi pesanan ke Discord |
| `ADMIN_TOKEN` | opsional, min. 16 karakter, untuk mengisi stok lewat `/api/admin` |

Setelah mengisi, **Redeploy**. Contoh lengkap ada di `.env.example`.

### 3. Webhook di dashboard Kipay
Dashboard Kipay → Projects → isi **Webhook URL**: `https://DOMAINMU.vercel.app/api/webhook`
Secret `whsec_...` hanya tampil **sekali** → salin ke `KIPAY_WEBHOOK_SECRET`. Klik tes webhook (`webhook.test`) — harus sukses.

### 4. Uji di Sandbox dulu
Pakai API key **sandbox** Kipay. Di popup QR akan muncul tombol **"Simulasikan pembayaran berhasil"** (hanya muncul di sandbox).
Setelah lancar, ganti `KIPAY_API_KEY` ke key production → tombol simulasi hilang otomatis.

## Mengganti / menambah produk
1. `index.html`: salin satu kartu produk, beri `data-id` unik pada tombol `.add-cart` (+ `data-name`, `data-price`)
2. `lib/catalog.js`: tambah id yang sama di `PRODUCTS` dengan harga & pesan pengiriman.
   - `stock: true` → tiap pembelian mengambil 1 item stok (akun / kode redeem). Butuh Redis.
   - tanpa `stock` → pembeli menerima `delivery.message` (mis. "admin proses ≤15 menit")
   - `needsUsername: true` → form meminta username Minecraft
3. Kode promo: `COUPONS` di file yang sama.

### Mengisi stok akun/kode
```bash
curl -X POST https://DOMAINMU.vercel.app/api/admin \
  -H "Authorization: Bearer $ADMIN_TOKEN" -H "Content-Type: application/json" \
  -d '{"action":"add-stock","productId":"acc-java","items":["email1:pass1","email2:pass2"]}'
# cek sisa stok:  GET /api/admin   (header yang sama)
```
Stok habis → checkout produk itu otomatis ditolak (tidak ada pesanan tanpa barang).

## Mode tanpa Redis
Tetap berfungsi (QR, cek status, pengiriman pesan), tetapi: tidak ada stok unik, tidak ada email otomatis,
dan pengiriman hanya muncul di browser pembeli saat halaman status dibuka. **Disarankan memakai Redis untuk produksi.**

## Uji lokal tanpa Kipay
`npm run dev` → http://localhost:3000 (Kipay & Redis palsu; QR hanya contoh, tidak bisa discan).
Uji dengan Kipay sungguhan: buat `.env.local` dari `.env.example`, lalu `npm run dev:real`.

## Struktur
```
api/checkout.js  buat pesanan + transaksi     api/webhook.js   terima webhook Kipay (verifikasi HMAC)
api/status.js    cek status + kirim produk    api/qr.js        proxy gambar QR (API key aman)
api/quote.js     hitung harga/promo           api/simulate.js  simulasi bayar (sandbox saja)
api/admin.js     kelola stok                  lib/*            logika bersama (katalog, Kipay, stok, email)
checkout.js      UI checkout/QR/pesanan       script.js        keranjang & UI toko
```

## Catatan keamanan
- Status "lunas" hanya dipercaya dari API Kipay (server-to-server), tidak pernah dari browser.
- Webhook ditolak bila signature salah / timestamp > 5 menit; pengiriman idempotent (tidak dobel).
- Pembeli harus membayar **nominal persis** (ada kode unik 3 digit dari Kipay).
- Jangan commit `.env` ke GitHub.
