// Thư viện dùng chung cho bot giao việc — KV, Google Sheet (qua Apps Script),
// bộ đọc tiếng Việt (người + hạn + ưu tiên), và các hàm gửi Telegram.
// File bắt đầu bằng "_" nên Vercel KHÔNG coi là endpoint.
// Không dùng thư viện ngoài — chỉ fetch + crypto có sẵn.

/* ============ Giờ Việt Nam (UTC+7) ============ */
const VN_OFFSET = 7 * 3600 * 1000;
const DOW_VN = ["Chủ nhật", "Thứ Hai", "Thứ Ba", "Thứ Tư", "Thứ Năm", "Thứ Sáu", "Thứ Bảy"];

/* Tách mốc thời gian thành các phần theo giờ VN */
function vnParts(ms) {
  const d = new Date(ms + VN_OFFSET);
  return {
    y: d.getUTCFullYear(), m: d.getUTCMonth() + 1, d: d.getUTCDate(),
    h: d.getUTCHours(), mi: d.getUTCMinutes(), dow: d.getUTCDay()
  };
}
/* Ghép các phần giờ VN trở lại mốc thời gian tuyệt đối */
function vnToMs(p) {
  return Date.UTC(p.y, p.m - 1, p.d, p.h || 0, p.mi || 0, 0, 0) - VN_OFFSET;
}
function vnAddDays(p, n) {
  const t = Date.UTC(p.y, p.m - 1, p.d + n, 12, 0, 0);
  const d = new Date(t);
  return { y: d.getUTCFullYear(), m: d.getUTCMonth() + 1, d: d.getUTCDate(), h: p.h, mi: p.mi, dow: d.getUTCDay() };
}
const pad2 = n => String(n).padStart(2, "0");
/* "17:00 · 14/08 (Thứ Sáu)" */
function fmtHan(ms) {
  if (!ms) return "—";
  const p = vnParts(ms);
  return pad2(p.h) + ":" + pad2(p.mi) + " · " + pad2(p.d) + "/" + pad2(p.m) + " (" + DOW_VN[p.dow] + ")";
}
function fmtNgay(ms) { const p = vnParts(ms); return pad2(p.d) + "/" + pad2(p.m) + "/" + p.y; }
function fmtGio(ms) { const p = vnParts(ms); return pad2(p.h) + ":" + pad2(p.mi); }
/* "còn 2h15" / "trễ 40 phút" */
function fmtConLai(ms, now) {
  const dt = ms - (now || Date.now());
  const a = Math.abs(dt), gio = Math.floor(a / 3600000), phut = Math.round((a % 3600000) / 60000);
  const s = gio ? gio + "h" + (phut ? pad2(phut) : "") : phut + " phút";
  return dt >= 0 ? "còn " + s : "trễ " + s;
}

/* ============ Bỏ dấu tiếng Việt, giữ nguyên độ dài chuỗi ============
   Giữ 1:1 để còn cắt đúng vị trí cụm thời gian ra khỏi nội dung việc. */
function bothDau(s) {
  let out = "";
  for (const ch of String(s)) {
    let c = ch;
    if (c === "đ" || c === "Đ") c = "d";
    else {
      try { c = c.normalize("NFD").replace(/[̀-ͯ]/g, "") || c; } catch (e) { }
      if (c.length !== 1) c = ch; /* giữ 1:1, ký tự lạ để nguyên */
    }
    out += c.toLowerCase();
  }
  return out;
}

/* ============ Vercel KV / Upstash Redis ============ */
const KV_URL = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL || "";
const KV_TOKEN = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN || "";
async function kv(cmd) {
  if (!KV_URL || !KV_TOKEN) return null;
  try {
    const r = await fetch(KV_URL, {
      method: "POST",
      headers: { Authorization: "Bearer " + KV_TOKEN, "Content-Type": "application/json" },
      body: JSON.stringify(cmd)
    });
    const j = await r.json();
    return j.result;
  } catch (e) { return null; }
}
async function kvGetJson(key) {
  const raw = await kv(["GET", key]);
  if (!raw) return null;
  try { return typeof raw === "string" ? JSON.parse(raw) : raw; } catch (e) { return null; }
}
const kvSetJson = (key, obj, ttl) =>
  kv(ttl ? ["SET", key, JSON.stringify(obj), "EX", ttl] : ["SET", key, JSON.stringify(obj)]);
/* Khoá chống làm trùng: chỉ lần gọi đầu tiên trả về true */
async function kvLock(key, ttl) { return (await kv(["SET", key, "1", "NX", "EX", ttl || 172800])) === "OK"; }

/* ============ Google Sheet qua Apps Script ============ */
const GS_URL = process.env.GS_WEBAPP_URL || "";
const GS_SECRET = process.env.GS_SECRET || "";
async function gs(action, payload) {
  if (!GS_URL) return { ok: false, error: "GS_WEBAPP_URL chưa cấu hình" };
  try {
    const r = await fetch(GS_URL, {
      method: "POST",
      headers: { "Content-Type": "text/plain;charset=utf-8" }, /* tránh preflight của Apps Script */
      body: JSON.stringify(Object.assign({ a: action, k: GS_SECRET }, payload || {})),
      redirect: "follow"
    });
    return await r.json();
  } catch (e) { return { ok: false, error: "" + (e && e.message ? e.message : e) }; }
}

/* ============ Bảng nhân sự ============
   Đọc từ Apps Script, cache 10 phút trong KV → thêm người không cần deploy lại. */
const ROSTER_KEY = "task:roster";
async function layNhanSu(buoc) {
  if (!buoc) { const c = await kvGetJson(ROSTER_KEY); if (c && c.list) return c.list; }
  const res = await gs("roster");
  const list = (res && res.ok && Array.isArray(res.list)) ? res.list : [];
  if (list.length) await kvSetJson(ROSTER_KEY, { list, t: Date.now() }, 600);
  return list;
}
/* Dò người trong câu: ưu tiên @username, sau đó tới bí danh dài nhất khớp trước.
   Trả về {nv, i, j, mo_ho} — mo_ho = có từ 2 người trở lên cùng khớp. */
function doNguoi(chuan, goc, roster) {
  /* duyệt MỌI @mention — cái đầu tiên thường là tag bot, phải bỏ qua để lấy cái sau */
  const re = /@([a-z0-9_]{4,32})/g;
  let mu;
  while ((mu = re.exec(chuan)) !== null) {
    const nv = roster.find(x => bothDau(x.tele || "").replace(/^@/, "") === mu[1]);
    if (nv) return { nv, i: mu.index, j: mu.index + mu[0].length, mo_ho: false };
  }
  const ung = [];
  for (const nv of roster) {
    const ds = [nv.ma, nv.ho_ten].concat(String(nv.bi_danh || "").split(","))
      .map(x => bothDau(String(x || "").trim())).filter(x => x.length >= 2);
    for (const bd of ds) {
      /* khớp trọn từ, không cắt giữa chữ */
      const re = new RegExp("(^|[^a-z0-9])" + bd.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "($|[^a-z0-9])");
      const m = chuan.match(re);
      if (m) ung.push({ nv, bd, i: m.index + m[1].length, j: m.index + m[1].length + bd.length });
    }
  }
  if (!ung.length) return null;
  ung.sort((a, b) => b.bd.length - a.bd.length);
  const top = ung[0];
  const khac = ung.filter(x => x.nv.ma !== top.nv.ma && x.bd.length === top.bd.length);
  return { nv: top.nv, i: top.i, j: top.j, mo_ho: khac.length > 0 };
}

/* ============ Bộ đọc hạn tiếng Việt ============
   Trả về {ms, cuts:[[i,j]...], mac_dinh:bool} — cuts để cắt cụm giờ khỏi nội dung. */
const THU = { "t2": 1, "t3": 2, "t4": 3, "t5": 4, "t6": 5, "t7": 6, "cn": 0 };
function doHan(chuan, nowMs) {
  const now = vnParts(nowMs);
  const cuts = [];
  let ngay = null, gio = null, buoi = null;
  const an = (m, extra) => cuts.push([m.index + (extra || 0), m.index + m[0].length]);

  /* --- ngày cụ thể dd/mm[/yyyy] --- */
  let m = chuan.match(/(^|[^0-9])(\d{1,2})\s*[/-]\s*(\d{1,2})(?:\s*[/-]\s*(\d{2,4}))?($|[^0-9])/);
  if (m) {
    const d = +m[2], mo = +m[3];
    if (d >= 1 && d <= 31 && mo >= 1 && mo <= 12) {
      let y = m[4] ? +m[4] : now.y; if (y < 100) y += 2000;
      ngay = { y, m: mo, d };
      if (!m[4] && vnToMs({ y, m: mo, d, h: 23, mi: 59 }) < nowMs) ngay.y = y + 1;
      cuts.push([m.index + m[1].length, m.index + m[0].length - m[5].length]);
    }
  }
  /* --- ngày tương đối --- */
  if (!ngay) {
    const bang = [
      [/(^|[^a-z])ngay kia($|[^a-z])/, 2], [/(^|[^a-z])ngay mot($|[^a-z])/, 2], [/(^|[^a-z])mot($|[^a-z])/, 2],
      [/(^|[^a-z])ngay mai($|[^a-z])/, 1], [/(^|[^a-z])mai($|[^a-z])/, 1],
      [/(^|[^a-z])hom nay($|[^a-z])/, 0], [/(^|[^a-z])trong ngay($|[^a-z])/, 0], [/(^|[^a-z])cuoi ngay($|[^a-z])/, 0],
      [/(^|[^a-z])tuan sau($|[^a-z])/, 7]
    ];
    for (const [re, n] of bang) {
      const mm = chuan.match(re);
      if (mm) {
        const p = vnAddDays(now, n); ngay = { y: p.y, m: p.m, d: p.d };
        cuts.push([mm.index + mm[1].length, mm.index + mm[0].length - mm[2].length]);
        if (/cuoi ngay|trong ngay/.test(mm[0])) gio = 18;
        break;
      }
    }
  }
  /* --- thứ trong tuần / cuối tuần / đầu tuần / trong tuần --- */
  if (!ngay) {
    const mt = chuan.match(/(^|[^a-z0-9])(thu\s*([2-7])|t([2-7])|chu nhat|cn|cuoi tuan|dau tuan|trong tuan)($|[^a-z0-9])/);
    if (mt) {
      const t = mt[2];
      let dich;
      if (/cuoi tuan/.test(t)) dich = 6;            /* Thứ Bảy */
      else if (/dau tuan/.test(t)) dich = 1;        /* Thứ Hai tuần sau */
      else if (/trong tuan/.test(t)) dich = 5;      /* Thứ Sáu */
      else if (/chu nhat|^cn$/.test(t)) dich = 0;
      else dich = THU["t" + (mt[3] || mt[4])];
      let delta = (dich - now.dow + 7) % 7;
      if (delta === 0 && /dau tuan|tuan sau/.test(t)) delta = 7;
      const p = vnAddDays(now, delta);
      ngay = { y: p.y, m: p.m, d: p.d };
      cuts.push([mt.index + mt[1].length, mt.index + mt[0].length - mt[5].length]);
    }
  }
  /* --- buổi trong ngày ---
     Bỏ dấu xong thì "chiều" đụng "chiếu" (đối chiếu), "tối" đụng "tối ưu" và "tôi".
     Nên chỉ tính là buổi khi có ngữ cảnh thời gian: đứng sau một mốc giờ
     ("5h chiều", "lúc chiều") hoặc đứng trước một mốc ngày ("chiều nay", "sáng t6"). */
  const RE_BUOI = /(^|[^a-z])(sang|trua|chieu|toi|dem)(\s+nay|\s+mai)?($|[^a-z])/g;
  let mb;
  while ((mb = RE_BUOI.exec(chuan)) !== null) {
    const i0 = mb.index + mb[1].length, j0 = mb.index + mb[0].length - mb[4].length;
    const truoc = chuan.slice(Math.max(0, i0 - 12), i0);
    const sau = chuan.slice(j0);
    const coGio = /\d{1,2}\s*(?:h|gio|:)\s*(?:\d{2})?\s*$/.test(truoc) || /(vao|luc|trong)\s+$/.test(truoc);
    const coNgay = /^\s*(nay|mai|mot|ngay kia|t[2-7]|thu\s*[2-7]|cn|chu nhat|\d{1,2}\s*[/-])/.test(sau);
    if (!coGio && !coNgay && !mb[3]) continue;
    buoi = mb[2];
    if (mb[3] && !ngay) {
      const p = vnAddDays(now, /mai/.test(mb[3]) ? 1 : 0);
      ngay = { y: p.y, m: p.m, d: p.d };
    }
    cuts.push([i0, j0]);
    break;
  }

  /* --- giờ: 17h, 17h30, 17:00, 5 gio --- */
  const mg = chuan.match(/(^|[^a-z0-9])(\d{1,2})\s*(?:h|gio|:)\s*(\d{2})?($|[^0-9])/);
  let phut = 0;
  if (mg) {
    let g = +mg[2];
    if (g >= 0 && g <= 24) {
      phut = mg[3] ? +mg[3] : 0;
      if (buoi === "chieu" && g <= 11) g += 12;
      else if ((buoi === "toi" || buoi === "dem") && g <= 11) g += 12;
      else if (buoi === "trua" && g < 11) g += 12;
      gio = g === 24 ? 23 : g;
      if (g === 24) phut = 59;
      cuts.push([mg.index + mg[1].length, mg.index + mg[0].length - mg[4].length]);
    }
  } else if (buoi && gio == null) {
    gio = { sang: 9, trua: 12, chieu: 15, toi: 20, dem: 21 }[buoi];
  }

  /* --- gấp / khẩn --- */
  const gap = /(^|[^a-z])(gap|khan|urgent|ngay lap tuc)($|[^a-z])/.test(chuan);

  /* --- ghép lại --- */
  let mac_dinh = false, ms;
  if (!ngay && gio == null) {
    if (gap) { ms = nowMs + 2 * 3600000; }
    else {
      const h18 = vnToMs({ y: now.y, m: now.m, d: now.d, h: 18, mi: 0 });
      ms = h18 > nowMs ? h18 : vnToMs(Object.assign(vnAddDays(now, 1), { h: 18, mi: 0 }));
      mac_dinh = true;
    }
  } else {
    const base = ngay || { y: now.y, m: now.m, d: now.d };
    if (gio == null) gio = 18;
    ms = vnToMs({ y: base.y, m: base.m, d: base.d, h: gio, mi: phut });
    /* chỉ có giờ mà giờ đó đã trôi qua → hiểu là ngày mai */
    if (!ngay && ms <= nowMs) { const p = vnAddDays(now, 1); ms = vnToMs({ y: p.y, m: p.m, d: p.d, h: gio, mi: phut }); }
  }
  return { ms, cuts, mac_dinh, gap };
}

/* ============ Đọc cả câu giao việc ============ */
function docViec(text, roster, nowMs) {
  const goc = String(text || "").replace(/\s+/g, " ").trim();
  const chuan = bothDau(goc);
  const cuts = [];

  /* bỏ tag bot ra khỏi câu */
  const mbot = chuan.match(/@[a-z0-9_]{4,32}\s*/g);
  const botName = bothDau(process.env.TASKBOT_USERNAME || "").replace(/^@/, "");
  if (botName) {
    const mb = chuan.indexOf("@" + botName);
    if (mb > -1) cuts.push([mb, mb + botName.length + 1]);
  }

  const ng = doNguoi(chuan, goc, roster);
  if (ng) cuts.push([ng.i, ng.j]);

  const han = doHan(chuan, nowMs);
  for (const c of han.cuts) cuts.push(c);

  /* cắt các cụm đã nhận ra khỏi nội dung */
  cuts.sort((a, b) => a[0] - b[0]);
  let noi_dung = "", pos = 0;
  for (const [i, j] of cuts) { if (i >= pos) { noi_dung += goc.slice(pos, i) + " "; pos = j; } else if (j > pos) pos = j; }
  noi_dung += goc.slice(pos);
  /* bỏ từ đệm — so sánh trên bản đã bỏ dấu để "gấp" cũng khớp với "gap".
     Cố ý KHÔNG bỏ: "ngay" (đụng "ngày"), "hạn" (đụng "gia hạn"), "với". */
  const DEM = new Set(["gap", "khan", "urgent", "nhe", "nha", "giup", "truoc", "vao", "luc", "deadline"]);
  noi_dung = noi_dung.split(/\s+/)
    .filter(w => w && !DEM.has(bothDau(w).replace(/[^a-z0-9]/g, "")))
    .join(" ").replace(/\s+/g, " ").replace(/^[\s,.:;-]+|[\s,.:;-]+$/g, "").trim();

  return {
    nguoi: ng ? ng.nv : null,
    nguoi_mo_ho: !!(ng && ng.mo_ho),
    noi_dung,
    han: han.ms,
    han_mac_dinh: han.mac_dinh,
    uu_tien: han.gap ? "cao" : "binh_thuong"
  };
}

/* ============ Việc: đọc / ghi ============ */
const PHONG_PREFIX = { VH: "VH", HR: "HR", KT: "KT" };
async function sinhMa(phong) {
  const p = PHONG_PREFIX[phong] || "VC";
  const n = await kv(["INCR", "task:seq:" + p]);
  return p + "-" + String(n || Date.now() % 10000).padStart(4, "0");
}
const K_TASK = ma => "task:t:" + ma;
async function docTask(ma) { return kvGetJson(K_TASK(ma)); }
async function ghiTask(t) {
  await kvSetJson(K_TASK(t.ma), t);
  await kv(["ZADD", "task:mo", t.trang_thai === "XONG" || t.trang_thai === "HUY" ? "-1" : String(t.han), t.ma]);
  if (t.trang_thai === "XONG" || t.trang_thai === "HUY") await kv(["ZREM", "task:mo", t.ma]);
  gs("upsert", { task: t }).catch(() => { }); /* ghi Sheet không chặn phản hồi Telegram */
  return t;
}
async function dsMo(denMs) {
  const ids = await kv(["ZRANGEBYSCORE", "task:mo", "0", String(denMs || Date.now() + 7 * 86400000)]);
  if (!Array.isArray(ids) || !ids.length) return [];
  const out = [];
  for (const ma of ids) { const t = await docTask(ma); if (t) out.push(t); }
  return out;
}

/* ============ Telegram ============ */
const TG = process.env.TASKBOT_TOKEN || process.env.TELEGRAM_BOT_TOKEN || "";
async function tg(method, body) {
  if (!TG) return { ok: false, description: "TASKBOT_TOKEN chưa cấu hình" };
  try {
    const r = await fetch("https://api.telegram.org/bot" + TG + "/" + method, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body)
    });
    return await r.json();
  } catch (e) { return { ok: false, description: "" + (e && e.message ? e.message : e) }; }
}
const guiTin = (chat_id, text, extra) => tg("sendMessage", Object.assign(
  { chat_id, text, parse_mode: "HTML", disable_web_page_preview: true }, extra || {}));
const suaTin = (chat_id, message_id, text, extra) => tg("editMessageText", Object.assign(
  { chat_id, message_id, text, parse_mode: "HTML", disable_web_page_preview: true }, extra || {}));

/* Nhắn riêng — người chưa /start bot thì Telegram chặn, trả về false để bot biết mà nhắc trong box */
async function nhanRieng(nv, text, extra) {
  if (!nv || !nv.tg_id) return false;
  const r = await guiTin(nv.tg_id, text, extra);
  return !!r.ok;
}

/* ============ Thẻ việc ============ */
const ICON = { MOI: "🆕", DA_NHAN: "✅", DANG_LAM: "▶️", XONG: "🏁", TRE: "🔴", HUY: "🗑" };
function theViec(t, nv) {
  const L = [];
  L.push((ICON[t.trang_thai] || "📌") + " <b>" + t.ma + "</b> · " + (nv ? nv.ho_ten : t.pic || "chưa rõ"));
  L.push("📋 " + (t.noi_dung || "<i>(chưa có nội dung)</i>"));
  L.push("⏰ " + fmtHan(t.han) + (t.trang_thai === "XONG" ? "" : " · " + fmtConLai(t.han)));
  if (t.uu_tien === "cao") L.push("🔥 Ưu tiên cao");
  if (t.canh_bao && t.canh_bao.length) L.push("⚠️ " + t.canh_bao.join(" · "));
  return L.join("\n");
}
const nut = (rows) => ({ inline_keyboard: rows });
const nutGiao = ma => nut([[
  { text: "✏️ Sửa hạn", callback_data: "h:" + ma },
  { text: "👤 Đổi người", callback_data: "p:" + ma },
  { text: "🗑 Huỷ", callback_data: "x:" + ma }
]]);
const nutNhan = ma => nut([
  [{ text: "✅ Nhận", callback_data: "n:" + ma }, { text: "🏁 Xong", callback_data: "d:" + ma }],
  [{ text: "⏰ Xin gia hạn", callback_data: "g:" + ma }, { text: "❓ Vướng", callback_data: "v:" + ma }]
]);

module.exports = {
  VN_OFFSET, DOW_VN, vnParts, vnToMs, vnAddDays, pad2,
  fmtHan, fmtNgay, fmtGio, fmtConLai, bothDau,
  kv, kvGetJson, kvSetJson, kvLock, gs,
  layNhanSu, doNguoi, doHan, docViec,
  sinhMa, docTask, ghiTask, dsMo,
  tg, guiTin, suaTin, nhanRieng,
  theViec, nut, nutGiao, nutNhan, ICON
};
