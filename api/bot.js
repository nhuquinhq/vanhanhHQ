// Webhook Telegram — bot giao việc.
// Cách dùng trong box: tag bot rồi nhắn bình thường
//    @trolyquynhhtn Quang đối soát NCC Galaxylink 17h mai
// Lệnh: /start (đăng ký nhận nhắn riêng) · /id (lấy chat id) · /viec (việc của tôi) · /ping
const L = require("./_lib");

/* Chỉ nhận update do đúng Telegram gửi (đặt secret khi setWebhook) */
function hopLe(req) {
  const s = process.env.TASKBOT_SECRET || "";
  if (!s) return true;
  return req.headers["x-telegram-bot-api-secret-token"] === s;
}
const BOT_USER = (process.env.TASKBOT_USERNAME || "").replace(/^@/, "").toLowerCase();

/* Bot có được gọi tới không: tag trong box · reply vào tin của bot · nhắn riêng */
function duocGoi(msg) {
  if (!msg || !msg.text) return false;
  if (msg.chat && msg.chat.type === "private") return true;
  if (msg.reply_to_message && msg.reply_to_message.from && msg.reply_to_message.from.is_bot) return true;
  return BOT_USER ? msg.text.toLowerCase().indexOf("@" + BOT_USER) > -1 : false;
}

/* Box nào thuộc phòng nào — khai qua biến môi trường */
function phongCuaBox(chatId) {
  const map = { VH: process.env.TG_VH, HR: process.env.TG_HR, KT: process.env.TG_KT };
  for (const p in map) if (map[p] && String(map[p]) === String(chatId)) return p;
  return null;
}

/* ---------- tạo việc từ một tin nhắn ---------- */
async function taoViec(msg) {
  const roster = await L.layNhanSu();
  const now = Date.now();
  const noiDungGoc = msg.reply_to_message && msg.reply_to_message.text
    ? msg.reply_to_message.text + " " + msg.text   /* reply tin cũ + tag bot → lấy cả ngữ cảnh */
    : msg.text;
  const doc = L.docViec(noiDungGoc, roster, now);

  const canh_bao = [];
  if (doc.han_mac_dinh) canh_bao.push("Không thấy hạn — tạm để 18:00");
  if (doc.nguoi_mo_ho) canh_bao.push("Tên trùng, kiểm tra lại người nhận");

  const phong = (doc.nguoi && doc.nguoi.phong) || phongCuaBox(msg.chat.id) || "VC";
  const ma = await L.sinhMa(phong);
  const t = {
    ma,
    ngay_giao: now,
    noi_dung: doc.noi_dung,
    pic: doc.nguoi ? doc.nguoi.ma : "",
    han: doc.han,
    box: String(msg.chat.id),
    box_ten: (msg.chat.title || "").slice(0, 60),
    phong,
    trang_thai: "MOI",
    uu_tien: doc.uu_tien,
    nguoi_giao: String((msg.from && msg.from.id) || ""),
    nguoi_giao_ten: ((msg.from && (msg.from.first_name || "")) + " " + (msg.from && msg.from.last_name || "")).trim(),
    luc_nhan: 0, luc_xong: 0, so_lan_doi_han: 0,
    link_tin: msg.chat.username ? "https://t.me/" + msg.chat.username + "/" + msg.message_id : "",
    canh_bao,
    lich_su: [{ t: now, v: "Tạo việc" }]
  };
  await L.ghiTask(t);

  /* thẻ xác nhận trong box */
  const r = await L.guiTin(msg.chat.id, L.theViec(t, doc.nguoi), {
    reply_to_message_id: msg.message_id,
    reply_markup: doc.nguoi ? L.nutGiao(ma) : hoiNguoi(ma, roster)
  });
  if (r.ok && r.result) { t.msg_box = r.result.message_id; await L.ghiTask(t); }

  /* nhắn riêng người làm */
  if (doc.nguoi) await moiNhan(t, doc.nguoi);
  return t;
}

function hoiNguoi(ma, roster) {
  const rows = [];
  for (let i = 0; i < roster.length; i += 3) {
    rows.push(roster.slice(i, i + 3).map(nv => ({
      text: (nv.ho_ten || nv.ma).split(" ").slice(-1)[0] || nv.ma,
      callback_data: "P:" + ma + ":" + nv.ma
    })));
  }
  rows.push([{ text: "🗑 Huỷ", callback_data: "x:" + ma }]);
  return L.nut(rows);
}
function hoiHan(ma) {
  return L.nut([
    [{ text: "Hôm nay 18h", callback_data: "H:" + ma + ":t18" }, { text: "Mai 12h", callback_data: "H:" + ma + ":m12" }],
    [{ text: "Mai 18h", callback_data: "H:" + ma + ":m18" }, { text: "Thứ 6 18h", callback_data: "H:" + ma + ":f18" }],
    [{ text: "+2 giờ", callback_data: "H:" + ma + ":p2" }, { text: "+1 ngày", callback_data: "H:" + ma + ":p24" }]
  ]);
}
function hanTu(ma_code, now) {
  const p = L.vnParts(now);
  const at = (n, h) => { const q = L.vnAddDays(p, n); return L.vnToMs({ y: q.y, m: q.m, d: q.d, h, mi: 0 }); };
  if (ma_code === "t18") return at(0, 18);
  if (ma_code === "m12") return at(1, 12);
  if (ma_code === "m18") return at(1, 18);
  if (ma_code === "f18") { let d = (5 - p.dow + 7) % 7; if (!d) d = 7; return at(d, 18); }
  if (ma_code === "p2") return now + 2 * 3600000;
  if (ma_code === "p24") return now + 86400000;
  return now + 86400000;
}

async function moiNhan(t, nv) {
  const txt = "📌 <b>" + t.ma + "</b> · việc mới\n📋 " + (t.noi_dung || "(chưa có nội dung)") +
    "\n⏰ Hạn " + L.fmtHan(t.han) +
    (t.nguoi_giao_ten ? "\n👤 Người giao: " + t.nguoi_giao_ten : "");
  const ok = await L.nhanRieng(nv, txt, { reply_markup: L.nutNhan(t.ma) });
  if (!ok && t.box) {
    await L.guiTin(t.box, "⚠️ Chưa nhắn riêng được cho <b>" + (nv.ho_ten || nv.ma) +
      "</b> — bạn ấy cần nhắn <code>/start</code> cho bot một lần.\n" + L.theViec(t, nv),
      { reply_markup: L.nutNhan(t.ma) });
  }
}

/* ---------- xử lý nút bấm ---------- */
async function xuLyNut(cq) {
  const data = String(cq.data || "");
  const [act, ma, arg] = data.split(":");
  const t = await L.docTask(ma);
  if (!t) return L.tg("answerCallbackQuery", { callback_query_id: cq.id, text: "Việc không còn tồn tại", show_alert: true });

  const roster = await L.layNhanSu();
  const nv = roster.find(x => x.ma === t.pic) || null;
  const nguoiBam = roster.find(x => String(x.tg_id) === String(cq.from.id));
  const ten = nguoiBam ? nguoiBam.ho_ten : (cq.from.first_name || "ai đó");
  let toast = "Đã ghi";

  const ghiSu = v => t.lich_su.push({ t: Date.now(), v });

  if (act === "n") { t.trang_thai = "DA_NHAN"; t.luc_nhan = Date.now(); ghiSu(ten + " nhận việc"); toast = "Đã nhận"; }
  else if (act === "d") { t.trang_thai = "XONG"; t.luc_xong = Date.now(); ghiSu(ten + " báo xong"); toast = "Đã đóng việc"; }
  else if (act === "v") {
    ghiSu(ten + " báo vướng");
    if (t.box) await L.guiTin(t.box, "❓ <b>" + t.ma + "</b> — " + ten + " báo vướng: " + (t.noi_dung || ""));
    toast = "Đã báo vướng lên box";
  }
  else if (act === "g" || act === "h") {
    await L.tg("answerCallbackQuery", { callback_query_id: cq.id, text: "Chọn hạn mới" });
    return L.tg("editMessageReplyMarkup", { chat_id: cq.message.chat.id, message_id: cq.message.message_id, reply_markup: hoiHan(ma) });
  }
  else if (act === "H") {
    const cu = t.han;
    t.han = hanTu(arg, Date.now());
    if (cu !== t.han) t.so_lan_doi_han = (t.so_lan_doi_han || 0) + 1;
    ghiSu(ten + " đổi hạn → " + L.fmtHan(t.han));
    toast = "Hạn mới: " + L.fmtHan(t.han);
  }
  else if (act === "p") {
    await L.tg("answerCallbackQuery", { callback_query_id: cq.id, text: "Chọn người" });
    return L.tg("editMessageReplyMarkup", { chat_id: cq.message.chat.id, message_id: cq.message.message_id, reply_markup: hoiNguoi(ma, roster) });
  }
  else if (act === "P") {
    const moi = roster.find(x => x.ma === arg);
    if (moi) { t.pic = moi.ma; t.phong = moi.phong || t.phong; ghiSu("Chuyển cho " + moi.ho_ten); await moiNhan(t, moi); toast = "Đã giao cho " + moi.ho_ten; }
  }
  else if (act === "x") { t.trang_thai = "HUY"; ghiSu(ten + " huỷ việc"); toast = "Đã huỷ"; }

  t.canh_bao = [];
  await L.ghiTask(t);
  await L.tg("answerCallbackQuery", { callback_query_id: cq.id, text: toast });

  const nvMoi = roster.find(x => x.ma === t.pic) || nv;
  const con = t.trang_thai === "XONG" || t.trang_thai === "HUY";
  return L.suaTin(cq.message.chat.id, cq.message.message_id, L.theViec(t, nvMoi),
    { reply_markup: con ? undefined : (act === "P" || act === "H" ? L.nutGiao(ma) : L.nutNhan(ma)) });
}

/* ---------- lệnh ---------- */
async function xuLyLenh(msg, lenh) {
  const chat = msg.chat.id;
  if (lenh === "id")
    return L.guiTin(chat, "🆔 Chat ID: <code>" + chat + "</code>\nLoại: " + msg.chat.type +
      (msg.message_thread_id ? "\nThread: <code>" + msg.message_thread_id + "</code>" : ""));
  if (lenh === "ping") return L.guiTin(chat, "🏓 Bot sống. Giờ VN: " + L.fmtHan(Date.now()));
  if (lenh === "start") {
    const roster = await L.layNhanSu();
    const u = (msg.from.username || "").toLowerCase();
    const nv = roster.find(x => L.bothDau(x.tele || "").replace(/^@/, "") === u);
    if (!nv) return L.guiTin(chat, "👋 Chào " + (msg.from.first_name || "") +
      "!\nChưa thấy <code>@" + (msg.from.username || "?") + "</code> trong bảng nhân sự. Nhờ sếp thêm giúp nhé.");
    await L.gs("set_tgid", { ma: nv.ma, tg_id: String(msg.from.id) });
    await L.kv(["DEL", "task:roster"]);
    return L.guiTin(chat, "✅ Đã đăng ký <b>" + nv.ho_ten + "</b> (" + (nv.phong || "?") +
      ").\nTừ giờ bot nhắc việc riêng cho bạn ở đây.");
  }
  if (lenh === "viec") {
    const roster = await L.layNhanSu();
    const nv = roster.find(x => String(x.tg_id) === String(msg.from.id));
    if (!nv) return L.guiTin(chat, "Bạn nhắn <code>/start</code> cho bot một lần trước đã nhé.");
    const ds = (await L.dsMo()).filter(x => x.pic === nv.ma);
    if (!ds.length) return L.guiTin(chat, "🎉 Bạn không còn việc nào đang treo.");
    ds.sort((a, b) => a.han - b.han);
    const L2 = ["📋 <b>Việc của " + nv.ho_ten + "</b> (" + ds.length + ")"];
    ds.forEach(t => L2.push("\n" + (t.han < Date.now() ? "🔴" : "•") + " <b>" + t.ma + "</b> " +
      (t.noi_dung || "") + "\n   ⏰ " + L.fmtHan(t.han) + " · " + L.fmtConLai(t.han)));
    return L.guiTin(chat, L2.join("\n"));
  }
  return null;
}

module.exports = async (req, res) => {
  if (req.method !== "POST") { res.status(200).json({ ok: true, bot: "task", hint: "webhook endpoint" }); return; }
  if (!hopLe(req)) { res.status(401).json({ ok: false }); return; }

  let up = req.body;
  try { if (typeof up === "string") up = JSON.parse(up); } catch (e) { up = {}; }
  res.status(200).json({ ok: true }); /* trả lời Telegram ngay, xử lý tiếp phía sau */

  try {
    if (up.callback_query) { await xuLyNut(up.callback_query); return; }
    const msg = up.message || up.edited_message;
    if (!msg || !msg.text) return;

    const ml = msg.text.trim().match(/^\/([a-z_]+)/i);
    if (ml) { await xuLyLenh(msg, ml[1].toLowerCase()); return; }

    if (!duocGoi(msg)) return;

    /* chống xử lý trùng khi Telegram gửi lại update */
    if (!(await L.kvLock("task:seen:" + msg.chat.id + ":" + msg.message_id, 3600))) return;

    const t = await taoViec(msg);
    if (!t.noi_dung) {
      await L.guiTin(msg.chat.id,
        "🤔 Tôi chưa hiểu việc này. Gõ giúp theo dạng:\n<code>@" + BOT_USER + " Quang đối soát NCC 17h mai</code>",
        { reply_to_message_id: msg.message_id });
    }
  } catch (e) {
    try {
      const chat = (up.message && up.message.chat && up.message.chat.id) ||
        (up.callback_query && up.callback_query.message && up.callback_query.message.chat.id);
      if (chat) await L.guiTin(chat, "⚠️ Bot gặp lỗi khi xử lý: <code>" + String(e.message || e).slice(0, 200) + "</code>");
    } catch (e2) { }
  }
};
