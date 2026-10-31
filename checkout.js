/* ZayyStore — checkout QRIS (Kipay): form data → QR → polling status → pengiriman otomatis */
(() => {
  const $ = (s, r=document) => r.querySelector(s);
  const $$ = (s, r=document) => [...r.querySelectorAll(s)];
  const money = n => "Rp " + Number(n).toLocaleString("id-ID");
  const esc = s => String(s).replace(/[&<>"']/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
  const toast = m => window.toast ? window.toast(m) : null;
  const LS = {
    get(k, d){ try{ const v=localStorage.getItem(k); return v?JSON.parse(v):d; }catch{ return d; } },
    set(k, v){ try{ localStorage.setItem(k, JSON.stringify(v)); }catch{} },
  };
  const api = async (path, opts) => {
    const r = await fetch(path, opts);
    const j = await r.json().catch(() => ({}));
    if (!r.ok) { const e = new Error(j.error || "Terjadi kesalahan. Coba lagi."); e.data = j; e.status = r.status; throw e; }
    return j;
  };

  const modal = $("#checkoutModal");
  const steps = { details:$("#stepDetails"), pay:$("#stepPay"), done:$("#stepDone"), end:$("#stepEnd") };
  let active = null;          // {token, orderId, amount, expiresAt, mode}
  let pollTimer = null, tickTimer = null, polling = false;

  /* ---------- tampilan ---------- */
  function show(name){
    Object.entries(steps).forEach(([k,el]) => el.hidden = k !== name);
    const n = name === "details" ? 1 : name === "pay" ? 2 : 3;
    $$("#coSteps li").forEach(li => { const s=+li.dataset.s; li.classList.toggle("on", s===n); li.classList.toggle("ok", s<n); });
    $("#coSteps").hidden = name === "end";
    modal.scrollTop = 0;
  }
  const openModal = () => { modal.classList.add("open"); modal.setAttribute("aria-hidden","false"); document.body.classList.add("no-scroll"); };
  function closeModal(){
    stopTimers(); modal.classList.remove("open"); modal.setAttribute("aria-hidden","true");
    document.body.classList.remove("no-scroll");
  }
  function stopTimers(){ clearInterval(pollTimer); clearInterval(tickTimer); pollTimer = tickTimer = null; }

  /* ---------- riwayat pesanan (di browser ini) ---------- */
  const orders = () => LS.get("zs_orders", []);
  function upsertOrder(o){
    const list = orders().filter(x => x.orderId !== o.orderId);
    list.unshift({ ...(orders().find(x => x.orderId === o.orderId) || {}), ...o });
    LS.set("zs_orders", list.slice(0, 25));
  }

  /* ---------- langkah 1: data pembeli ---------- */
  async function open({ coupon }) {
    openModal(); show("details");
    $("#coError").hidden = true;
    $("#coSubmit").disabled = true;
    $("#coSummary").innerHTML = '<div class="co-skel"></div>';
    try {
      const items = JSON.parse(localStorage.getItem("zs_cart") || "[]").map(i => ({ id:i.id, qty:i.qty }));
      const q = await api("/api/quote", { method:"POST", headers:{"Content-Type":"application/json"}, body:JSON.stringify({ items, coupon }) });
      $("#coSummary").innerHTML = q.lines.map(l => `<div class="co-line"><span>${esc(l.name)} <em>×${l.qty}</em></span><b>${money(l.total)}</b></div>`).join("")
        + (q.discount ? `<div class="co-line disc"><span>Diskon ${esc(q.coupon.code)}</span><b>-${money(q.discount)}</b></div>` : "")
        + `<div class="co-line total"><span>Total</span><strong>${money(q.total)}</strong></div>`;
      $("#coUserWrap").hidden = !q.needsUsername;
      $("#coUser").required = q.needsUsername;
      $("#coEmail").value = $("#coEmail").value || LS.get("zs_email", "");
      $("#coUser").value = $("#coUser").value || LS.get("zs_username", "");
      $("#coSubmit").disabled = false;
      $("#checkoutForm").dataset.coupon = q.coupon ? q.coupon.code : "";
      setTimeout(() => $("#coEmail").focus(), 150);
    } catch (e) {
      $("#coSummary").innerHTML = "";
      showError(e.message);
    }
  }

  function showError(msg){ const el = $("#coError"); el.textContent = msg; el.hidden = false; }

  $("#checkoutForm").addEventListener("submit", async e => {
    e.preventDefault();
    const email = $("#coEmail").value.trim();
    const username = $("#coUser").value.trim();
    $("#coError").hidden = true;
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email)) return showError("Masukkan email yang valid.");
    if (!$("#coUserWrap").hidden && !/^[A-Za-z0-9_ .]{3,24}$/.test(username)) return showError("Username Minecraft 3–24 karakter (huruf, angka, _ . spasi).");

    const btn = $("#coSubmit"); btn.disabled = true; btn.classList.add("loading");
    try {
      const items = JSON.parse(localStorage.getItem("zs_cart") || "[]").map(i => ({ id:i.id, qty:i.qty }));
      const o = await api("/api/checkout", { method:"POST", headers:{"Content-Type":"application/json"},
        body: JSON.stringify({ items, email, username, coupon: e.target.dataset.coupon || "" }) });
      LS.set("zs_email", email); if (username) LS.set("zs_username", username);
      upsertOrder({ token:o.token, orderId:o.orderId, total:o.total, ts:Date.now(), status:"pending" });
      document.dispatchEvent(new CustomEvent("zs:ordercreated"));
      startPay(o);
    } catch (err) {
      showError(err.message);
    } finally { btn.disabled = false; btn.classList.remove("loading"); }
  });

  /* ---------- langkah 2: scan QR ---------- */
  function startPay(o) {
    stopTimers();
    active = { token:o.token, orderId:o.orderId, amount:o.amount, expiresAt:o.expiresAt, mode:o.mode };
    show("pay");
    $("#payAmount").textContent = money(o.amount);
    $("#payOrderId").textContent = o.orderId;
    $("#payStatusText").textContent = "Menunggu pembayaran…";
    $("#sandboxBox").hidden = o.mode !== "sandbox";
    const img = $("#qrImg"), ld = $("#qrLoading");
    ld.hidden = false; ld.classList.remove("err"); ld.innerHTML = "<i></i>";
    img.classList.remove("ready");
    img.onload = () => { ld.hidden = true; img.classList.add("ready"); };
    img.onerror = () => { ld.classList.add("err"); ld.innerHTML = "<span>QR gagal dimuat</span><button type='button' id='qrRetry'>Muat ulang</button>"; };
    img.src = `/api/qr?token=${encodeURIComponent(o.token)}&t=${Date.now()}`;
    tick(); tickTimer = setInterval(tick, 1000);
    pollTimer = setInterval(poll, 3000); poll();
  }

  $("#qrLoading").addEventListener("click", e => { if (e.target.id === "qrRetry" && active) startPay({ ...active }); });

  function tick() {
    if (!active) return;
    const left = Math.max(0, Math.floor((active.expiresAt - Date.now()) / 1000));
    $("#payTimer").textContent = String(Math.floor(left/60)).padStart(2,"0") + ":" + String(left%60).padStart(2,"0");
    $("#payTimer").classList.toggle("low", left < 60);
    if (left === 0 && !active.finalCheck) { active.finalCheck = true; poll(true); }
  }

  async function poll(final = false) {
    if (!active || polling) return;
    polling = true;
    const token = active.token;
    try {
      const s = await api(`/api/status?token=${encodeURIComponent(token)}`);
      if (!active || active.token !== token) return;
      if (s.status === "paid") return finish(s);
      if (s.status === "processing") $("#payStatusText").textContent = "Pembayaran diterima, menyiapkan pesanan…";
      else if (s.status === "expired") return expire(s);
      else if (final) return expire(s);
    } catch (e) {
      if (e.status === 409 && e.data && e.data.status === "error") { stopTimers(); return fail(e.data); }
    } finally { polling = false; }
  }

  $("#copyAmount").addEventListener("click", () => copy(String(active.amount), "Nominal disalin"));
  $("#simulateBtn").addEventListener("click", async e => {
    const b = e.currentTarget; b.disabled = true;
    try { await api("/api/simulate", { method:"POST", headers:{"Content-Type":"application/json"}, body:JSON.stringify({ token:active.token }) }); poll(); }
    catch (err) { toast(err.message); } finally { b.disabled = false; }
  });
  $("#payClose").addEventListener("click", closeModal);

  /* ---------- langkah 3: selesai ---------- */
  function finish(s) {
    stopTimers();
    upsertOrder({ orderId:s.orderId, status:"paid" });
    show("done");
    $("#doneIcon").className = "done-icon"; $("#doneIcon").textContent = "✓";
    $("#doneTitle").innerHTML = "Pembayaran <span>berhasil!</span>";
    $("#doneSub").innerHTML = `ID Pesanan <b>${esc(s.orderId)}</b> • ${money(s.total)}${s.email ? `<br>Salinan detail dikirim ke <b>${esc(s.email)}</b> (cek folder spam bila belum masuk).` : ""}`;
    $("#deliveryList").innerHTML = (s.deliveries || []).map(d => `
      <div class="delivery ${d.manual ? "manual" : ""}">
        <div class="d-head"><b>${esc(d.title)}</b><span>× ${d.qty}</span></div>
        <p>${esc(d.message)}</p>
        ${(d.codes || []).map(c => `<div class="code"><code>${esc(c)}</code><button type="button" data-copy="${esc(c)}">Salin</button></div>`).join("")}
      </div>`).join("");
    confetti();
  }

  function expire(s) {
    stopTimers();
    upsertOrder({ orderId:active ? active.orderId : s.orderId, status:"expired" });
    show("end");
    $("#endIcon").className = "done-icon warn"; $("#endIcon").textContent = "⌛";
    $("#endTitle").innerHTML = "Waktu pembayaran <span>habis</span>";
    $("#endSub").textContent = "QR sudah tidak berlaku. Jangan bayar ke QR lama — buat pesanan baru.";
    $("#endRetry").textContent = "Buat pesanan baru";
    $("#endRetry").onclick = () => { closeModal(); document.getElementById("cartOpen").click(); };
  }

  function fail(d) {
    show("end");
    $("#endIcon").className = "done-icon bad"; $("#endIcon").textContent = "!";
    $("#endTitle").innerHTML = "Perlu <span>bantuan admin</span>";
    $("#endSub").textContent = d.error || "Terjadi masalah pada pesanan ini.";
    $("#endRetry").textContent = "Tutup";
    $("#endRetry").onclick = closeModal;
  }

  $("#doneAgain").addEventListener("click", () => { closeModal(); document.getElementById("produk").scrollIntoView({ behavior:"smooth" }); });
  $("#deliveryList").addEventListener("click", e => { const b = e.target.closest("[data-copy]"); if (b) copy(b.dataset.copy, "Disalin ✓"); });

  /* ---------- buka pesanan lama ---------- */
  async function openOrder(token) {
    openModal();
    try {
      const s = await api(`/api/status?token=${encodeURIComponent(token)}`);
      if (s.status === "paid") return finish(s);
      if (s.status === "expired") { active = { orderId:s.orderId }; return expire(s); }
      startPay({ token, orderId:s.orderId, amount:s.amount, expiresAt:s.expiresAt, mode:s.mode });
    } catch (e) {
      show("end"); $("#endIcon").className = "done-icon bad"; $("#endIcon").textContent = "!";
      $("#endTitle").innerHTML = "Pesanan <span>tidak ditemukan</span>"; $("#endSub").textContent = e.message;
      $("#endRetry").textContent = "Tutup"; $("#endRetry").onclick = closeModal;
    }
  }

  /* ---------- modal "Pesanan Saya" ---------- */
  const ordersModal = $("#ordersModal");
  const BADGE = { paid:["Lunas","ok"], pending:["Menunggu bayar","wait"], expired:["Kedaluwarsa","off"] };
  function renderOrders() {
    const list = orders();
    $("#ordersList").innerHTML = list.length ? list.map(o => {
      const [label, cls] = BADGE[o.status] || BADGE.pending;
      return `<div class="order-row"><div><b>${esc(o.orderId)}</b><small>${new Date(o.ts || Date.now()).toLocaleString("id-ID", { dateStyle:"medium", timeStyle:"short" })} • ${money(o.total || 0)}</small></div><span class="badge ${cls}">${label}</span><button type="button" data-order="${esc(o.orderId)}">${o.status === "paid" ? "Detail" : o.status === "expired" ? "Lihat" : "Bayar"}</button></div>`;
    }).join("") : '<div class="empty-cart">🧾<b>Belum ada pesanan</b><small>Pesanan yang kamu buat di perangkat ini muncul di sini.</small></div>';
  }
  function openOrders() {
    renderOrders(); ordersModal.classList.add("open"); document.body.classList.add("no-scroll");
    // segarkan status pesanan yang masih menunggu
    orders().filter(o => o.status === "pending").slice(0, 5).forEach(async o => {
      try { const s = await api(`/api/status?token=${encodeURIComponent(o.token)}`); upsertOrder({ orderId:o.orderId, status:s.status === "processing" ? "paid" : s.status }); renderOrders(); } catch {}
    });
  }
  const closeOrders = () => { ordersModal.classList.remove("open"); document.body.classList.remove("no-scroll"); };
  $("#ordersOpen").addEventListener("click", openOrders);
  $("#footerOrders").addEventListener("click", e => { e.preventDefault(); openOrders(); });
  $("#ordersClose").addEventListener("click", closeOrders);
  ordersModal.addEventListener("click", e => { if (e.target === ordersModal) closeOrders(); });
  $("#ordersList").addEventListener("click", e => {
    const b = e.target.closest("[data-order]"); if (!b) return;
    const o = orders().find(x => x.orderId === b.dataset.order); if (!o) return;
    closeOrders(); openOrder(o.token);
  });

  /* ---------- util ---------- */
  async function copy(text, msg) {
    try { await navigator.clipboard.writeText(text); } catch {
      const t = document.createElement("textarea"); t.value = text; document.body.appendChild(t); t.select();
      try { document.execCommand("copy"); } catch {} t.remove();
    }
    toast(msg);
  }

  function confetti() {
    if (matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    const host = $("#stepDone"); const colors = ["#1765f5","#4592ff","#26b987","#f2a400","#883bea"];
    for (let i = 0; i < 36; i++) {
      const p = document.createElement("i"); p.className = "confetti";
      p.style.cssText = `left:${Math.random()*100}%;background:${colors[i%5]};animation-delay:${Math.random()*.4}s;--dx:${(Math.random()-.5)*160}px;--r:${Math.random()*720}deg`;
      host.appendChild(p); setTimeout(() => p.remove(), 2200);
    }
  }

  $("#checkoutClose").addEventListener("click", closeModal);
  modal.addEventListener("click", e => { if (e.target === modal) closeModal(); });
  document.addEventListener("keydown", e => { if (e.key === "Escape") { if (modal.classList.contains("open")) closeModal(); closeOrders(); } });
  // tab lain/ponsel dibuka kembali setelah bayar di aplikasi bank -> segera cek status
  document.addEventListener("visibilitychange", () => { if (!document.hidden && active && modal.classList.contains("open") && !steps.pay.hidden) poll(); });

  window.ZSCheckout = { open, openOrder };
})();
