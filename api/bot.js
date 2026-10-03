// Vercel Serverless Function (CommonJS) — ĐẦU NHẬN tin nhắn Telegram (webhook)
// Kế toán tag bot trong box rồi hỏi tên NCC → bot trả lời số tiền nên nạp,
// căn cứ MỨC TIÊU BÌNH QUÂN 3 NGÀY GẦN NHẤT trên tab "Data Chi tiết".
//
// Quy tắc nạp (đổi ở NGAY_DU bên dưới):
//   tiêu < 1.000/ngày  → nạp cho 3 ngày (OG, Galaxylink, RBX…)
//   1.000 – 2.000/ngày → nạp cho 2 ngày
//   > 2.000/ngày       → nạp cho 1 ngày, tức nạp hàng ngày (giftcard BSV…)
//
// Bật webhook: gọi /api/tele?hook=set&key=<TELE_SECRET> (xem thêm ?hook=info · ?hook=del)
const tele = require("./tele.js");

const fmt = n => Math.round(n).toLocaleString("vi-VN");
const fu = n => n ? n.toLocaleString("vi-VN", { maximumFractionDigits: 2 }) : "0";
const stripD = s => { try { return ("" + s).normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/đ/g, "d").replace(/Đ/g, "D").toLowerCase(); } catch (e) { return ("" + s).toLowerCase(); } };

/* số ngày nên nạp trước theo mức tiêu bình quân (tính bằng USDT, nguồn VNĐ quy ra để so) */
function ngayDu(bqUSDT) {
  if (bqUSDT < 1000) return { ngay: 3, muc: "thấp (dưới 1.000/ngày)" };
  if (bqUSDT < 2000) return { ngay: 2, muc: "vừa (1.000–2.000/ngày)" };
  return { ngay: 1, muc: "cao (trên 2.000/ngày) — nên nạp hàng ngày" };
}
/* làm tròn LÊN cho số tiền đề xuất: USDT lên bội số 100, VNĐ lên bội số 1 triệu */
const tronLen = (n, b) => Math.ceil(n / b) * b;

/* tên gọi tắt kế toán hay dùng → tên cột trên sheet */
const BIET_DANH = {
  "bsv": "giftcard", "bep": "giftcard", "conggame": "giftcard", "gc": "giftcard",
  "galaxy": "galaxylink", "glx": "galaxylink",
  "sc": "supercell", "razer": "razer gold", "rz": "razer gold",
  "oggaming": "og", "ogg": "og"
};
function timNguon(P, chu) {
  const t = stripD(chu).replace(/[^a-z0-9 ]/g, " ").replace(/\s+/g, " ").trim();
  if (!t) return null;
  const ten = s => stripD(s).replace(/^data\s+/, "");
  /* khớp nguyên cụm trước, sau đó khớp từng từ (kể cả qua biệt danh) */
  let hit = P.src.find(s => t === ten(s.name) || t.indexOf(ten(s.name)) > -1);
  if (hit) return hit;
  for (const w of t.split(" ")) {
    const key = BIET_DANH[w] || w;
    hit = P.src.find(s => ten(s.name) === key || ten(s.name).indexOf(key) > -1 || key.indexOf(ten(s.name)) > -1);
    if (hit) return hit;
  }
  return null;
}

/* n ngày gần nhất CÓ SỐ trên tab (ngày trống chưa nhập liệu thì không tính) */
function mayNgay(P, n) {
  const tong = k => P.src.reduce((a, s) => a + (s.daily[k] || 0), 0);
  return P.days.filter(k => tong(k) > 0).slice(-n);
}
const baNgay = P => mayNgay(P, 3);
const nhan = k => k.slice(3) + "/" + k.slice(0, 2);
const tenNg = n => n.replace(/^data\s+/i, "");

function traLoiMot(P, rate, s, ks0) {
  const usd = s.usd;
  let ks = ks0, ghiChu = "";
  /* NCC mua theo đợt (Galaxylink, Razer…) có thể 3 ngày liền không phát sinh —
     lúc đó lấy bình quân 7 ngày để con số còn dùng được, và nói rõ là đã nới ra 7 ngày */
  if (!ks.reduce((a, k) => a + (s.daily[k] || 0), 0)) {
    const k7 = mayNgay(P, 7);
    if (k7.reduce((a, k) => a + (s.daily[k] || 0), 0)) { ks = k7; ghiChu = "ℹ️ 3 ngày gần nhất không phát sinh nên lấy bình quân 7 ngày."; }
  }
  const so = ks.map(k => s.daily[k] || 0);
  const bq = so.reduce((a, b) => a + b, 0) / (ks.length || 1);
  const bqUSDT = usd ? bq : bq / rate(ks[ks.length - 1] || "");
  const R = ngayDu(bqUSDT);
  const can = usd ? tronLen(bq * R.ngay, 100) : tronLen(bq * R.ngay, 1e6);
  const dv = usd ? " USDT" : " đ";
  const mm = (ks[ks.length - 1] || "").slice(0, 2);
  const thang = P.days.filter(k => k.slice(0, 2) === mm).reduce((a, k) => a + (s.daily[k] || 0), 0);
  const L = ["💰 <b>Nạp NCC — " + tenNg(s.name) + "</b>"];
  L.push("🗓 " + ks.length + " ngày gần nhất: " + ks.map((k, i) => nhan(k) + " " + (usd ? fu(so[i]) : fmt(so[i]))).join(" · "));
  L.push("📊 Bình quân: <b>" + (usd ? fu(bq) : fmt(bq)) + dv + "/ngày</b> · mức tiêu " + R.muc);
  L.push("👉 <b>Đề xuất nạp: " + (usd ? fmt(can) : fmt(can)) + dv + "</b> (đủ dùng ~" + R.ngay + " ngày)");
  L.push("📈 Đã nhập tháng " + (+mm) + ": " + (usd ? fu(thang) : fmt(thang)) + dv);
  if (ghiChu) L.push(ghiChu);
  if (!bq) L.push("⚠️ 7 ngày gần nhất chưa phát sinh đơn nào — chưa có căn cứ để tính, chị kiểm tra lại tên NCC giúp em.");
  return L.join("\n");
}

function traLoiTatCa(P, rate, ks) {
  const L = ["💰 <b>Gợi ý nạp theo NCC</b> — bình quân " + ks.length + " ngày gần nhất (" + ks.map(nhan).join(" · ") + ")"];
  const ds = P.src.map(s => {
    const bq = ks.reduce((a, k) => a + (s.daily[k] || 0), 0) / (ks.length || 1);
    const bqUSDT = s.usd ? bq : bq / rate(ks[ks.length - 1] || "");
    const R = ngayDu(bqUSDT);
    const can = s.usd ? tronLen(bq * R.ngay, 100) : tronLen(bq * R.ngay, 1e6);
    return { n: tenNg(s.name), usd: s.usd, bq: bq, bqUSDT: bqUSDT, ngay: R.ngay, can: can };
  }).filter(x => x.bq > 0).sort((a, b) => b.bqUSDT - a.bqUSDT);
  if (!ds.length) return "Chưa có số nhập nào trong 3 ngày gần nhất.";
  ds.forEach(x => L.push(" • <b>" + x.n + "</b>: tiêu " + (x.usd ? fu(x.bq) + " USDT" : fmt(x.bq) + " đ") +
    "/ngày → nạp <b>" + fmt(x.can) + (x.usd ? " USDT" : " đ") + "</b> (~" + x.ngay + " ngày)"));
  L.push("", "<i>Quy tắc: dưới 1.000/ngày nạp 3 ngày · 1.000–2.000 nạp 2 ngày · trên 2.000 nạp hàng ngày.</i>");
  L.push("<i>Hỏi riêng một NCC: tag bot kèm tên, ví dụ “@bot galaxy” hoặc “/nap bsv”.</i>");
  return L.join("\n");
}

module.exports = async (req, res) => {
  const SECRET = (process.env.TELE_SECRET || "").trim();
  const q = req.query || {};
  const hdr = req.headers["x-telegram-bot-api-secret-token"] || "";
  if (SECRET && hdr !== SECRET && q.k !== SECRET) { res.status(401).json({ error: "unauthorized" }); return; }

  let up = req.body;
  if (!up || typeof up !== "object") {           /* phòng khi Vercel không tự đọc JSON */
    try { up = JSON.parse(await new Promise(r => { let b = ""; req.on("data", c => b += c); req.on("end", () => r(b || "{}")); })); }
    catch (e) { up = {}; }
  }
  const msg = up.message || up.edited_message;
  const text = msg && (msg.text || msg.caption);
  if (!msg || !text) { res.status(200).json({ ok: true, bo_qua: "khong_phai_tin_chu" }); return; }

  const token = process.env.TELEGRAM_BOT_TOKEN;
  const api = (m, b) => fetch("https://api.telegram.org/bot" + token + "/" + m, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(b)
  }).then(x => x.json()).catch(e => ({ ok: false, description: "" + e }));

  /* chỉ trả lời trong các box đã khai (box bắn báo cáo + TELE_BOT_CHATS nếu có) */
  const dsBox = ((process.env.TELE_BOT_CHATS || "") + "," + (tele.BOX_MAC_DINH && tele.BOX_MAC_DINH.nhap || "") + "," +
                 (process.env.TELEGRAM_TARGETS || "") + "," + (process.env.TELEGRAM_CHAT_ID || "") + "," + (process.env.TELEGRAM_CHAT_ID_2 || ""))
    .split(/[,;\s]+/).filter(Boolean).map(x => x.split(":")[0]);
  const chat = "" + (msg.chat && msg.chat.id);
  if (dsBox.length && dsBox.indexOf(chat) < 0) { res.status(200).json({ ok: true, bo_qua: "box_khong_trong_danh_sach", chat: chat }); return; }

  /* có gọi bot không: /nap… hoặc @tên_bot hoặc trả lời chính tin của bot */
  let me = "";
  try { const g = await api("getMe", {}); me = (g && g.result && g.result.username) ? g.result.username.toLowerCase() : ""; } catch (e) {}
  const low = text.toLowerCase();
  const goiBot = /^\/nap/i.test(text.trim()) || (me && low.indexOf("@" + me) > -1) ||
                 !!(msg.reply_to_message && msg.reply_to_message.from && msg.reply_to_message.from.is_bot);
  if (!goiBot) { res.status(200).json({ ok: true, bo_qua: "khong_goi_bot" }); return; }

  const D = await tele.docNhap();
  const tra = t => api("sendMessage", Object.assign({
    chat_id: msg.chat.id, text: t, parse_mode: "HTML", disable_web_page_preview: true,
    reply_to_message_id: msg.message_id
  }, msg.message_thread_id ? { message_thread_id: msg.message_thread_id } : {}));

  if (!D.P) { await tra("Chưa đọc được tab “Data Chi tiết” nên chưa tính được. Kiểm tra lại link Đăng lên web giúp em."); res.status(200).json({ ok: true, loi: "khong_doc_duoc" }); return; }

  const ks = baNgay(D.P);
  if (!ks.length) { await tra("Tab “Data Chi tiết” chưa có số của 3 ngày gần nhất."); res.status(200).json({ ok: true, loi: "chua_co_so" }); return; }

  /* bỏ phần gọi bot ra khỏi câu hỏi rồi tìm tên NCC trong phần còn lại */
  const hoi = text.replace(/^\/nap(@\S+)?/i, " ").replace(new RegExp("@" + (me || "x"), "ig"), " ")
    .replace(/\b(nap|nạp|tien|tiền|bao nhieu|bao nhiêu|ncc|cho|can|cần)\b/gi, " ").trim();
  const s = timNguon(D.P, hoi);
  const loi = s ? traLoiMot(D.P, D.rate, s, ks) : traLoiTatCa(D.P, D.rate, ks);
  const j = await tra(loi + (D.coTyGia ? "" : "\n<i>⚠ chưa đọc được bảng tỷ giá tuần, số quy đổi đang tạm tính</i>"));
  res.status(200).json({ ok: !!(j && j.ok), ncc: s ? s.name : "tat_ca", ngay: ks });
};
