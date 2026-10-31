const $ = (s, root=document) => root.querySelector(s);
const $$ = (s, root=document) => [...root.querySelectorAll(s)];
const money = n => "Rp " + Number(n).toLocaleString("id-ID");
const esc = s => String(s).replace(/[&<>"']/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
const toast = (message) => { const el=$("#toast"); el.textContent=message; el.classList.add("show"); clearTimeout(window.toastTimer); window.toastTimer=setTimeout(()=>el.classList.remove("show"),2800); };
const store = {
  get(k, d){ try{ const v=localStorage.getItem(k); return v?JSON.parse(v):d; }catch{ return d; } },
  set(k, v){ try{ localStorage.setItem(k, JSON.stringify(v)); }catch{} },
};

/* ===================== KERANJANG ===================== */
// item: {id, name, price, qty, needsUsername}  — harga di sini hanya untuk tampilan; server menghitung ulang saat checkout.
let cart = store.get("zs_cart", []).filter(i => i && i.id && i.qty > 0);
let coupon = store.get("zs_coupon", "");
let quote = null; // hasil perhitungan server (diskon dsb.)

const subtotalLocal = () => cart.reduce((s,i)=>s+i.price*i.qty,0);
const saveCart = () => { store.set("zs_cart", cart); store.set("zs_coupon", coupon); };

async function refreshQuote(showErrors=false){
  quote = null;
  if (!cart.length) return renderTotals();
  try{
    const r = await fetch("/api/quote", {method:"POST", headers:{"Content-Type":"application/json"}, body:JSON.stringify({items:cart.map(i=>({id:i.id,qty:i.qty})), coupon})});
    const j = await r.json();
    if (!r.ok) throw new Error(j.error || "Gagal menghitung");
    quote = j;
  }catch(e){
    if (coupon){ coupon=""; saveCart(); if(showErrors) toast(e.message); }
  }
  renderTotals();
}

function renderTotals(){
  const sub = quote ? quote.subtotal : subtotalLocal();
  const disc = quote ? quote.discount : 0;
  $("#cartSubtotal").textContent = money(sub);
  $("#cartTotal").textContent = money(sub - disc);
  const row = $("#discountRow");
  row.hidden = !(quote && quote.coupon && disc > 0);
  if (!row.hidden){ $("#couponLabel").textContent = `(${quote.coupon.code})`; $("#cartDiscount").textContent = "-" + money(disc); }
  $("#couponInput").value = quote && quote.coupon ? quote.coupon.code : "";
  $("#checkoutBtn").disabled = !cart.length;
}

function renderCart(){
  $("#cartCount").textContent = cart.reduce((sum,item)=>sum+item.qty,0);
  const box = $("#cartItems");
  if(!cart.length){
    box.innerHTML = '<div class="empty-cart">🛒<b>Keranjang masih kosong</b><small>Tambahkan produk yang kamu suka.</small></div>';
  } else {
    box.innerHTML = cart.map((item,i)=>`<div class="cart-row"><div class="cart-product-icon">✦</div><div class="cart-row-info"><b>${esc(item.name)}</b><small>${money(item.price)}</small><div class="qty"><button data-dec="${i}" aria-label="Kurangi">−</button><span>${item.qty}</span><button data-inc="${i}" aria-label="Tambah">＋</button></div></div><div class="cart-line-total">${money(item.price*item.qty)}</div><button class="remove-item" data-remove="${i}" aria-label="Hapus produk">×</button></div>`).join("");
  }
  renderTotals();
}

function changeCart(){ saveCart(); renderCart(); refreshQuote(); }

$("#cartItems").addEventListener("click", e => {
  const b = e.target.closest("button"); if(!b) return;
  if (b.dataset.inc !== undefined){ const it=cart[+b.dataset.inc]; if(it.qty<10) it.qty++; else toast("Maksimal 10 per produk."); }
  else if (b.dataset.dec !== undefined){ const it=cart[+b.dataset.dec]; it.qty--; if(it.qty<1) cart.splice(+b.dataset.dec,1); }
  else if (b.dataset.remove !== undefined){ cart.splice(+b.dataset.remove,1); }
  else return;
  changeCart();
});

$$(".add-cart").forEach(btn=>btn.addEventListener("click",()=>{
  const id=btn.dataset.id, name=btn.dataset.name, price=Number(btn.dataset.price);
  const existing=cart.find(i=>i.id===id);
  if(existing){ if(existing.qty>=10) return toast("Maksimal 10 per produk."); existing.qty++; }
  else cart.push({id,name,price,qty:1});
  changeCart(); toast(name+" ditambahkan ke keranjang");
  const c=$("#cartOpen"); c.classList.remove("bump"); void c.offsetWidth; c.classList.add("bump");
}));

$("#couponForm").addEventListener("submit", async e => {
  e.preventDefault();
  const code = $("#couponInput").value.trim().toUpperCase();
  if(!code) return;
  if(!cart.length) return toast("Tambahkan produk dulu sebelum memakai kode promo.");
  coupon = code; await refreshQuote(true);
  if (quote && quote.coupon) { saveCart(); toast(`Kode ${quote.coupon.code} dipakai — hemat ${money(quote.discount)} 🎉`); }
});
$("#couponRemove").addEventListener("click", () => { coupon=""; saveCart(); refreshQuote(); });

const openCart  = () => $("#cartOverlay").classList.add("open");
const closeCart = () => $("#cartOverlay").classList.remove("open");
$("#cartOpen").addEventListener("click", openCart);
$("#cartClose").addEventListener("click", closeCart);
$("#cartOverlay").addEventListener("click", e => { if(e.target===$("#cartOverlay")) closeCart(); });

$("#checkoutBtn").addEventListener("click", () => {
  if(!cart.length) return toast("Keranjang kamu masih kosong.");
  closeCart();
  window.ZSCheckout.open({ cart: cart.map(i=>({...i})), coupon, quote });
});

/* ===================== FILTER, CARI, UI LAMA ===================== */
$$(".filter").forEach(btn=>btn.addEventListener("click",()=>{
  $$(".filter").forEach(b=>b.classList.remove("active"));btn.classList.add("active");
  const f=btn.dataset.filter;
  $$(".product-card").forEach(card=>card.style.display=(f==="all"||card.dataset.category===f)?"":"none");
}));
$("#loginBtn").addEventListener("click",()=>$("#loginModal").classList.add("open"));
$("#loginClose").addEventListener("click",()=>$("#loginModal").classList.remove("open"));
$("#loginModal").addEventListener("click",e=>{if(e.target===$("#loginModal"))$("#loginModal").classList.remove("open")});
$("#loginForm").addEventListener("submit",e=>{e.preventDefault();$("#loginModal").classList.remove("open");toast("Login member belum aktif — kamu tetap bisa belanja tanpa akun.");});
$("#newsletterForm").addEventListener("submit",e=>{e.preventDefault();toast("Terima kasih! Kamu akan dapat info promo terbaru.");e.target.reset();});
$("#mobileMenu").addEventListener("click",()=>$("#nav").classList.toggle("open"));
$$('#nav a').forEach(a=>a.addEventListener('click',()=>$("#nav").classList.remove("open")));
$("#searchToggle").addEventListener("click",()=>{const term=prompt("Cari produk ZayyStore:");if(!term)return;let found=0;$$(".product-card").forEach(card=>{const match=card.innerText.toLowerCase().includes(term.toLowerCase());card.style.display=match?"":"none";if(match)found++;});$$(".filter").forEach(b=>b.classList.remove("active"));$("#produk").scrollIntoView({behavior:"smooth"});toast(found?`Ditemukan ${found} produk.`:"Produk tidak ditemukan.");});
$$(".quick-view").forEach(btn=>btn.addEventListener("click",()=>{const card=btn.closest(".product-card");card.querySelector(".add-cart").click();}));
document.addEventListener("keydown", e => { if(e.key==="Escape"){ closeCart(); $("#loginModal").classList.remove("open"); } });

renderCart();
if (cart.length) refreshQuote();

window.toast = toast;
// Setelah pesanan dibuat, keranjang dikosongkan (pesanan tersimpan di "Pesanan Saya").
document.addEventListener("zs:ordercreated", () => { cart = []; coupon = ""; quote = null; saveCart(); renderCart(); });
