// Vercel Serverless Function — Bot bắn báo cáo dashboard vào box Telegram
// Gọi: /api/tele?r=pvh10[&d=17/07][&dry=1][&key=<TELE_SECRET>][&slot=auto]
//  - GitHub Actions gõ cửa nhiều lần quanh mỗi khung giờ với slot=auto → server tự quyết theo GIỜ VN:
//    đúng khung 12h/18h/23h (trong 3 tiếng sau mốc) mới gửi, mỗi khung chỉ gửi 1 lần (đánh dấu KV).
//    Lý do: bộ hẹn giờ GitHub hay trễ vô chừng (có hôm job 12h trưa bị nhả lúc 3h sáng).
//  - dry=1: chỉ trả về nội dung để xem thử, KHÔNG gửi
//  - Env cần có: TELEGRAM_BOT_TOKEN · TELEGRAM_CHAT_ID · (tuỳ chọn) TELEGRAM_THREAD_ID, TELE_SECRET
const FILE_SLA = "2PACX-1vRHGRhq3zSjBYecJRUbTLwlgjvx-A7hIu8J0eSkUKuXZI7uMWYLjyUeIKefumrnQLC5jIbW55y0lE1W";
const GIDS = { tc: "1496740945", gp_ngay: "511745866" };

const KV_URL = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL || "";
const KV_TOKEN = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN || "";
async function kv(cmd) {
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

/* ---- tiện ích ---- */
function csvParse(input) {
  const rows = []; let row = [], cell = "", q = false;
  for (let i = 0; i < input.length; i++) {
    const ch = input[i];
    if (q) { if (ch === '"') { if (input[i + 1] === '"') { cell += '"'; i++; } else q = false; } else cell += ch; }
    else if (ch === '"') q = true;
    else if (ch === ",") { row.push(cell); cell = ""; }
    else if (ch === "\n" || ch === "\r") { if (ch === "\r" && input[i + 1] === "\n") i++; row.push(cell); cell = ""; rows.push(row); row = []; }
    else cell += ch;
  }
  row.push(cell); if (row.length > 1 || row[0] !== "") rows.push(row);
  return rows;
}
const nrm = x => { try { x = ("" + x).normalize("NFC"); } catch (e) { x = "" + x; } return x.replace(/ /g, " ").replace(/\s+/g, " ").trim(); };
function vnum(x) {
  if (x == null) return 0; x = ("" + x).replace(/["\s₫đ$%]/g, ""); if (x === "" || x === "-") return 0;
  if (x.indexOf(",") > -1 && x.indexOf(".") === -1) x = x.replace(",", ".");
  else if (x.indexOf(",") > -1) { if (x.lastIndexOf(",") > x.lastIndexOf(".")) x = x.replace(/\./g, "").replace(",", "."); else x = x.replace(/,/g, ""); }
  else if ((x.match(/\./g) || []).length > 1 || /^-?\d{1,3}(\.\d{3})+$/.test(x)) x = x.replace(/\./g, "");
  const n = parseFloat(x); return isNaN(n) ? 0 : n;
}
const fmt = n => Math.round(n).toLocaleString("vi-VN");
const pct = x => (x * 100).toFixed(1).replace(".", ",") + "%";
async function readTab(gid) {
  const url = "https://docs.google.com/spreadsheets/d/e/" + FILE_SLA + "/pub?gid=" + gid + "&single=true&output=csv";
  try {
    const r = await fetch(url, { redirect: "follow" }); if (!r.ok) return null;
    const t = await r.text();
    if (t.trimStart().slice(0, 200).toLowerCase().startsWith("<")) return null;
    const rows = csvParse(t); return rows.length > 1 ? rows : null;
  } catch (e) { return null; }
}
/* dò hàng "Ngày" + các cột ngày dd/mm — dùng chung cho các tab dạng báo cáo ngày */
function dateHeader(rows) {
  for (let r = 0; r < Math.min(rows.length, 12); r++) {
    const row = rows[r] || [];
    const iN = row.findIndex(x => nrm(x).toLowerCase() === "ngày"); if (iN < 0) continue;
    const cols = [];
    for (let c = iN + 1; c < row.length; c++) {
      const m = nrm(row[c]).match(/^(\d{1,2})\/(\d{1,2})(?:\/\d{4})?$/);
      if (m) { const dd = +m[1], mo = +m[2]; if (mo >= 1 && mo <= 12 && dd >= 1 && dd <= 31) cols.push({ ci: c, dk: String(mo).padStart(2, "0") + "-" + String(dd).padStart(2, "0") }); }
    }
    if (cols.length >= 5) return { HR: r, dateCols: cols };
  }
  return null;
}
const labOf = (rows, r) => { const row = rows[r] || []; for (let c = 0; c < Math.min(row.length, 4); c++) { const v = nrm(row[c]); if (v) return v; } return ""; };

/* ---- tab "Tổng đơn xử lý thủ công": các dòng "Số đơn <loại>" ---- */
function parseTC(rows) {
  const H = dateHeader(rows); if (!H) return null;
  let iTot = -1;
  for (let r = H.HR; r < Math.min(rows.length, H.HR + 4) && iTot < 0; r++) iTot = (rows[r] || []).findIndex(x => /^total$/i.test(nrm(x)));
  let kpiTxt = ""; const types = [];
  for (let r = H.HR + 1; r < rows.length; r++) {
    const l = labOf(rows, r); if (!l) continue;
    if (/số\s*lượng\s*thủ\s*công/i.test(l)) { kpiTxt = (rows[r] || []).map(nrm).filter(x => x && !/số\s*lượng|^kpi$/i.test(x)).join(" "); continue; }
    if (!/^số\s*đơn/i.test(l)) continue;
    const row = rows[r] || []; const daily = {}; let any = false;
    H.dateCols.forEach(dc => { const v = nrm(row[dc.ci]); if (v !== "") { daily[dc.dk] = vnum(v); any = true; } });
    const tot = (iTot > -1 ? (vnum(row[iTot]) || vnum(row[iTot + 1])) : 0) || Object.keys(daily).reduce((a, k) => a + daily[k], 0);
    if (!any && !tot) continue;
    const name = l.replace(/^số\s*đơn\s*/i, "").trim();
    types.push({ name: name ? name.charAt(0).toUpperCase() + name.slice(1) : l, tot, daily });
  }
  return types.length ? { dateCols: H.dateCols, types, kpi: kpiTxt } : null;
}
/* ---- tab Gamepass "Theo tháng": lấy dòng TỔNG của từng khối chỉ số theo ngày ---- */
function parseThangTong(rows) {
  const H = dateHeader(rows); if (!H) return null;
  const SS = [["ps", /đơn\s*phát\s*sinh/i], ["ht", /đơn\s*hoàn\s*tất/i], ["lt", /lead\s*time/i], ["pc", /tỷ\s*lệ.*(kpi|leadtime)/i], ["hy", /đơn\s*h[uủ]y/i]];
  const marks = [];
  for (let r = H.HR + 1; r < rows.length; r++) {
    const l = labOf(rows, r); if (!l) continue;
    for (const [k, re] of SS) { if (re.test(l) && !marks.some(m => m.k === k)) { marks.push({ k, r }); break; } }
  }
  if (!marks.length) return null;
  const out = {};
  marks.forEach(m => {
    const nxt = marks.filter(x => x.r > m.r).sort((a, b) => a.r - b.r)[0]; const end = nxt ? nxt.r : rows.length;
    let row = null;
    for (let r = m.r + 1; r < end; r++) {
      const l = labOf(rows, r);
      if (/^tổng/i.test(l)) { row = rows[r]; break; }
      if (!row && H.dateCols.some(dc => nrm((rows[r] || [])[dc.ci]) !== "")) row = rows[r];
    }
    if (!row) return;
    H.dateCols.forEach(dc => { const v = nrm(row[dc.ci]); if (v === "") return; (out[dc.dk] = out[dc.dk] || {})[m.k] = vnum(v); });
  });
  return Object.keys(out).length ? out : null;
}

/* ---- dựng nội dung báo cáo PVH10 ---- */
async function buildPVH10(q) {
  const [tcRows, gpRows] = await Promise.all([readTab(GIDS.tc), readTab(GIDS.gp_ngay)]);
  const now = new Date(Date.now() + 7 * 3600 * 1000); /* giờ VN (UTC+7) */
  let dd = now.getUTCDate(), mo = now.getUTCMonth() + 1;
  const md = q.d && ("" + q.d).match(/^(\d{1,2})\/(\d{1,2})$/); if (md) { dd = +md[1]; mo = +md[2]; }
  let key = String(mo).padStart(2, "0") + "-" + String(dd).padStart(2, "0");
  const lines = ["📊 <b>PVH10 · Năng suất xử lý đơn thủ công</b>"];
  const P = tcRows ? parseTC(tcRows) : null;
  if (P) {
    const avail = P.dateCols.map(c => c.dk).filter(k => P.types.some(t => t.daily[k] != null));
    if (avail.length && avail.indexOf(key) < 0) { const past = avail.filter(k => k <= key); key = past.length ? past[past.length - 1] : avail[avail.length - 1]; }
    lines.push("🗓 Ngày " + key.slice(3) + "/" + key.slice(0, 2) + "/2026");
    const day = P.types.map(t => ({ name: t.name, v: t.daily[key] || 0 }));
    const dTot = day.reduce((a, x) => a + x.v, 0);
    lines.push("", "🧮 <b>Đơn thủ công trong ngày: " + fmt(dTot) + "</b>");
    day.forEach(x => lines.push(" • " + x.name + ": " + fmt(x.v)));
    const mm = key.slice(0, 2);
    const cum = P.types.map(t => ({ name: t.name, v: Object.keys(t.daily).filter(k => k.slice(0, 2) === mm && k <= key).reduce((a, k) => a + t.daily[k], 0) }));
    const cTot = cum.reduce((a, x) => a + x.v, 0);
    const nDays = P.dateCols.filter(c => c.dk.slice(0, 2) === mm && c.dk <= key && P.types.some(t => t.daily[c.dk] != null)).length;
    lines.push("", "📈 Lũy kế tháng " + (+mm) + ": <b>" + fmt(cTot) + " đơn</b>" + (P.kpi ? " · KPI " + P.kpi : ""));
    cum.forEach(x => lines.push(" • " + x.name + ": " + fmt(x.v) + (cTot ? " (" + pct(x.v / cTot) + ")" : "")));
    if (nDays) lines.push(" • Bình quân: " + fmt(cTot / nDays) + " đơn/ngày");
  } else lines.push("", '⚠️ Không đọc được tab "Tổng đơn xử lý thủ công" — kiểm tra Publish to web.');
  const G = gpRows ? parseThangTong(gpRows) : null;
  if (G && G[key]) {
    const g = G[key], bits = [];
    if (g.ps != null) bits.push("phát sinh " + fmt(g.ps));
    if (g.ht != null) bits.push("hoàn tất " + fmt(g.ht));
    if (g.lt) bits.push("lead time " + ("" + g.lt).replace(".", ",") + "h");
    if (g.pc) bits.push("đạt KPI " + ("" + g.pc).replace(".", ",") + "%");
    if (g.hy) bits.push("hủy " + fmt(g.hy));
    if (bits.length) lines.push("", "🎮 Gamepass trong ngày: " + bits.join(" · "));
  }
  const dom = process.env.DASH_URL || (process.env.VERCEL_PROJECT_PRODUCTION_URL ? "https://" + process.env.VERCEL_PROJECT_PRODUCTION_URL : "");
  if (dom) lines.push("", "🔗 Chi tiết: " + dom);
  return lines.join("\n");
}

const REPORTS = { pvh10: buildPVH10 };

module.exports = async (req, res) => {
  const q = req.query || {};
  const SECRET = process.env.TELE_SECRET || "";
  const isCron = !!req.headers["x-vercel-cron"] || /vercel-cron/i.test(req.headers["user-agent"] || "");
  if (SECRET && !isCron && q.key !== SECRET) { res.status(401).json({ error: "unauthorized" }); return; }
  const r = ("" + (q.r || "pvh10")).toLowerCase();
  if (!REPORTS[r]) { res.status(400).json({ error: "unknown_report", reports: Object.keys(REPORTS) }); return; }
  /* slot=auto: gác giờ VN — chỉ gửi trong khung [mốc, mốc+3h), mỗi khung 1 lần/ngày */
  let markKey = null;
  if (q.slot === "auto") {
    const SLOTS = [12, 18, 23];
    const pad = x => String(x).padStart(2, "0");
    const vn = new Date(Date.now() + 7 * 3600 * 1000);
    const mins = vn.getUTCHours() * 60 + vn.getUTCMinutes();
    let slot = null, base = vn;
    for (const h of SLOTS) { if (mins >= h * 60 && mins < h * 60 + 180) slot = h; }
    if (slot == null && mins < 120) { slot = 23; base = new Date(vn.getTime() - 86400000); } /* 23h kéo sang 0h–2h hôm sau */
    const gioVN = pad(vn.getUTCHours()) + ":" + pad(vn.getUTCMinutes());
    if (slot == null) { res.status(200).json({ ok: true, skip: "ngoai_khung_gio", gio_vn: gioVN }); return; }
    markKey = "pvh:tele:" + base.getUTCFullYear() + "-" + pad(base.getUTCMonth() + 1) + "-" + pad(base.getUTCDate()) + ":" + slot + "h:" + r;
    if (KV_URL && KV_TOKEN) {
      const got = await kv(["SET", markKey, "1", "NX", "EX", 172800]); /* NX: chỉ lần gõ cửa đầu tiên của khung được gửi */
      if (got !== "OK") { res.status(200).json({ ok: true, skip: "khung_" + slot + "h_da_gui", gio_vn: gioVN }); return; }
    } else if (mins >= slot * 60 + 60 && !(slot === 23 && mins < 120)) {
      /* không có KV thì không chống trùng được — chỉ nhận lần gõ trong giờ đầu của khung */
      res.status(200).json({ ok: true, skip: "kv_chua_cau_hinh_qua_gio_dau" }); return;
    }
  }
  const text = await REPORTS[r](q);
  if (q.dry) { res.setHeader("Content-Type", "text/plain; charset=utf-8"); res.status(200).send(text); return; }
  const token = process.env.TELEGRAM_BOT_TOKEN, chat = process.env.TELEGRAM_CHAT_ID;
  if (!token || !chat) { res.status(200).json({ error: "telegram_not_configured", need: ["TELEGRAM_BOT_TOKEN", "TELEGRAM_CHAT_ID"] }); return; }
  const body = { chat_id: chat, text, parse_mode: "HTML", disable_web_page_preview: true };
  if (process.env.TELEGRAM_THREAD_ID) body.message_thread_id = +process.env.TELEGRAM_THREAD_ID;
  try {
    const tg = await fetch("https://api.telegram.org/bot" + token + "/sendMessage", {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body)
    });
    const j = await tg.json();
    if (!j.ok && markKey) await kv(["DEL", markKey]); /* gửi hỏng thì nhả khung để lần gõ cửa sau thử lại */
    res.status(200).json(j.ok ? { ok: true, report: r } : { ok: false, telegram: j });
  } catch (e) {
    if (markKey) await kv(["DEL", markKey]);
    res.status(502).json({ ok: false, error: "" + (e && e.message ? e.message : e) });
  }
};
