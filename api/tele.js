// Vercel Serverless Function — Bot bắn báo cáo dashboard vào box Telegram
// Gọi: /api/tele?r=pvh10[&d=17/07][&dry=1][&key=<TELE_SECRET>][&slot=auto]
//  - GitHub Actions gõ cửa nhiều lần quanh mỗi khung giờ với slot=auto → server tự quyết theo GIỜ VN:
//    đúng khung 12h/18h/23h (trong 3 tiếng sau mốc) mới gửi, mỗi khung chỉ gửi 1 lần (đánh dấu KV).
//    Lý do: bộ hẹn giờ GitHub hay trễ vô chừng (có hôm job 12h trưa bị nhả lúc 3h sáng).
//  - dry=1: chỉ trả về nội dung để xem thử, KHÔNG gửi
//  - Env cần có: TELEGRAM_BOT_TOKEN · TELEGRAM_CHAT_ID · (tuỳ chọn) TELEGRAM_THREAD_ID, TELE_SECRET
const FILE_SLA = "2PACX-1vRHGRhq3zSjBYecJRUbTLwlgjvx-A7hIu8J0eSkUKuXZI7uMWYLjyUeIKefumrnQLC5jIbW55y0lE1W";
const GIDS = { tc: "1496740945", gp_ngay: "511745866" };

/* Danh sách box nhận báo cáo.
   - TELEGRAM_CHAT_ID (+ TELEGRAM_THREAD_ID)  : box 1
   - TELEGRAM_CHAT_ID_2 (+ TELEGRAM_THREAD_ID_2), _3, _4 …: các box thêm
   - TELEGRAM_TARGETS: khai báo gọn nhiều box một dòng "chatid:topicid,chatid,…" (ưu tiên nếu có) */
function targets() {
  const T = (process.env.TELEGRAM_TARGETS || "").trim();
  if (T) return T.split(/[,;\s]+/).filter(Boolean).map(x => {
    const p = x.split(":"); return { chat: p[0], thread: p[1] ? +p[1] : null };
  });
  const out = [];
  const add = (c, t) => { if (c && !out.some(o => o.chat === c)) out.push({ chat: c, thread: t ? +t : null }); };
  add(process.env.TELEGRAM_CHAT_ID, process.env.TELEGRAM_THREAD_ID);
  for (let i = 2; i <= 6; i++) add(process.env["TELEGRAM_CHAT_ID_" + i], process.env["TELEGRAM_THREAD_ID_" + i]);
  return out;
}

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
const PAL = ["#1e5fd0", "#fb923c", "#0e7c86", "#7c3aed", "#be185d", "#15803d", "#eab308", "#22d3ee", "#94a3b8", "#f43f5e"];
/* dựng ảnh biểu đồ qua QuickChart: POST lấy link ngắn rồi để Telegram tự tải ảnh về */
async function chartURL(cfg) {
  try {
    const r = await fetch("https://quickchart.io/chart/create", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chart: cfg, width: 900, height: 480, backgroundColor: "white", devicePixelRatio: 2 })
    });
    const j = await r.json();
    return j && j.success && j.url ? j.url : null;
  } catch (e) { return null; }
}
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

/* ---- tab "Tổng đơn xử lý thủ công": các dòng "Số đơn <loại>" ----
   Tab xếp NHIỀU KHỐI THÁNG chồng nhau (Tháng 7, Tháng 8…) — dò MỌI hàng tiêu đề "Ngày";
   hàng "Số đơn…" thuộc khối gần nhất phía trên, cùng tên loại thì gộp qua các tháng. */
const SLA_SKIP = /^(t[ỷy]\s*l[ệe]|kpi|t[ổo]ng|s[ốo]\s*l[ưu][ợo]ng|avg|b[ìi]nh\s*qu[âa]n|ng[àa]y|th[ứu]|tu[ầa]n|th[áa]ng|n[ăa]m|ghi\s*ch[úu]|stt|b[áa]o\s*c[áa]o)/i;
function parseTC(rows) {
  const heads = [];
  for (let r = 0; r < rows.length; r++) {
    const row = rows[r] || [];
    const iN = row.findIndex(x => nrm(x).toLowerCase() === "ngày"); if (iN < 0) continue;
    const cols = [];
    for (let c = iN + 1; c < row.length; c++) {
      const m = nrm(row[c]).match(/^(\d{1,2})\/(\d{1,2})(?:\/\d{4})?$/);
      if (m) { const dd = +m[1], mo = +m[2]; if (mo >= 1 && mo <= 12 && dd >= 1 && dd <= 31) cols.push({ ci: c, dk: String(mo).padStart(2, "0") + "-" + String(dd).padStart(2, "0") }); }
    }
    if (cols.length >= 5) heads.push({ HR: r, dateCols: cols });
  }
  if (!heads.length) return null;
  let iTot = -1;
  for (let r = heads[0].HR; r < Math.min(rows.length, heads[0].HR + 4) && iTot < 0; r++) iTot = (rows[r] || []).findIndex(x => /^total$/i.test(nrm(x)));
  let kpiTxt = ""; const tmap = {}, order = [];
  heads.forEach((H, hi) => {
    const end = hi + 1 < heads.length ? heads[hi + 1].HR : rows.length;
    for (let r = H.HR + 1; r < end; r++) {
      const l = labOf(rows, r); if (!l) continue;
      // dòng tổng theo ngày; chỉ nhặt ô CHỮ (vd "35 đơn/ca") làm KPI, bỏ các ô số
      if (/số\s*lượng\s*thủ\s*công/i.test(l)) { if (!kpiTxt) kpiTxt = (rows[r] || []).map(nrm).filter(x => x && !/số\s*lượng|^kpi$/i.test(x) && /[a-zA-ZÀ-ỹ]/.test(x)).join(" "); continue; }
      // loại đơn mới đặt tên trần (không có tiền tố "Số đơn") vẫn được nhận — chỉ bỏ dòng tiêu đề/tỷ lệ/tổng
      if (SLA_SKIP.test(l)) continue;
      const row = rows[r] || []; const daily = {}; let any = false;
      H.dateCols.forEach(dc => { const v = nrm(row[dc.ci]); if (v !== "") { daily[dc.dk] = vnum(v); any = true; } });
      const tot = (iTot > -1 ? (vnum(row[iTot]) || vnum(row[iTot + 1])) : 0) || Object.keys(daily).reduce((a, k) => a + daily[k], 0);
      if (!any && !tot) continue;
      if (!Object.keys(daily).some(k => daily[k] > 0) && !(tot > 0)) continue; // dòng tiêu đề lọt vào
      const name = l.replace(/^(số\s*đơn|sl\s*đơn|đơn)\s+/i, "").trim(); const key = (name || l).toLowerCase();
      if (!tmap[key]) { tmap[key] = { name: name ? name.charAt(0).toUpperCase() + name.slice(1) : l, tot: 0, daily: {} }; order.push(key); }
      tmap[key].tot += tot; Object.assign(tmap[key].daily, daily);
    }
  });
  const types = order.map(k => tmap[k]);
  return types.length ? { dateCols: heads.reduce((a, h) => a.concat(h.dateCols), []), types, kpi: kpiTxt } : null;
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
  let chartCfg = null;
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
    /* biểu đồ cột chồng: các ngày trong tháng tới ngày báo cáo */
    const days = P.dateCols.map(c => c.dk).filter((k, i, a) => k.slice(0, 2) === mm && k <= key && a.indexOf(k) === i).sort();
    const used = P.types.filter(t => days.some(k => (t.daily[k] || 0) > 0));
    if (days.length && used.length) chartCfg = {
      type: "bar",
      data: {
        labels: days.map(k => k.slice(3) + "/" + k.slice(0, 2)),
        datasets: used.map((t, i) => ({ label: t.name, data: days.map(k => t.daily[k] || 0), backgroundColor: PAL[i % PAL.length] }))
      },
      options: {
        title: { display: true, text: "Đơn thủ công theo ngày — tháng " + (+mm) + "/2026 · tổng " + fmt(cTot) + " đơn", fontSize: 16 },
        legend: { position: "bottom", labels: { boxWidth: 12, fontSize: 11 } },
        scales: { xAxes: [{ stacked: true, ticks: { fontSize: 10 } }], yAxes: [{ stacked: true, ticks: { beginAtZero: true } }] }
      }
    };
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
  return { text: lines.join("\n"), chart: chartCfg };
}

const REPORTS = { pvh10: buildPVH10 };

module.exports = async (req, res) => {
  const q = req.query || {};
  const SECRET = process.env.TELE_SECRET || "";
  const isCron = !!req.headers["x-vercel-cron"] || /vercel-cron/i.test(req.headers["user-agent"] || "");
  if (SECRET && !isCron && q.key !== SECRET) { res.status(401).json({ error: "unauthorized" }); return; }
  if (isCron && !q.slot && !q.dry) q.slot = "auto"; /* Vercel Cron gọi trần /api/tele → tự đi qua gác giờ VN */
  /* ?peek=1 — trang tra cứu chat id / topic id: gõ tin trong đúng topic rồi mở link này.
     Chỉ trả về id + tên box, KHÔNG hiện nội dung tin nhắn. */
  if (q.peek) {
    const token0 = process.env.TELEGRAM_BOT_TOKEN;
    if (!token0) { res.status(200).send("Chua khai bao TELEGRAM_BOT_TOKEN"); return; }
    let out = "";
    try {
      const rr = await fetch("https://api.telegram.org/bot" + token0 + "/getUpdates?limit=50");
      const jj = await rr.json();
      const seen = {}, rows = [];
      (jj.result || []).forEach(u => {
        const m = u.message || u.channel_post || u.edited_message; if (!m || !m.chat) return;
        const th = m.message_thread_id || (m.is_topic_message ? 1 : null);
        const k = m.chat.id + "/" + (th || "-");
        if (seen[k]) return; seen[k] = 1;
        rows.push({ chat_id: m.chat.id, ten_box: m.chat.title || m.chat.username || "(chat riêng)", topic_id: th || null,
                    topic: m.reply_to_message && m.reply_to_message.forum_topic_created ? m.reply_to_message.forum_topic_created.name : undefined,
                    luc: new Date((m.date + 7 * 3600) * 1000).toISOString().replace("T", " ").slice(5, 16) + " (giờ VN)" });
      });
      out = rows.length
        ? "CAC BOX BOT VUA NHAN DUOC TIN:\n\n" + rows.map(x => JSON.stringify(x)).join("\n") +
          "\n\nCach dung: TELEGRAM_CHAT_ID_2 = chat_id · TELEGRAM_THREAD_ID_2 = topic_id (bo qua neu topic_id = null)."
        : "Chua thay tin nao. Hay go '@bcpvh_bot test' NGAY TRONG topic muon nhan bao cao roi tai lai trang nay.\n" +
          "(Bot chi 'thay' tin trong nhom khi tin do nhac ten bot hoac la lenh /...)";
    } catch (e) { out = "Loi goi Telegram: " + (e && e.message ? e.message : e); }
    res.setHeader("Content-Type", "text/plain; charset=utf-8"); res.status(200).send(out); return;
  }
  const r = ("" + (q.r || "pvh10")).toLowerCase();
  if (!REPORTS[r]) { res.status(400).json({ error: "unknown_report", reports: Object.keys(REPORTS) }); return; }
  /* slot=auto: gác giờ VN — chỉ gửi trong khung [mốc, mốc+3h), mỗi khung 1 lần/ngày */
  let markKey = null;
  if (q.slot === "auto") {
    const SLOTS = { 12: 180, 18: 240, 23: 180 }; /* khung 18h nới 4 tiếng — GitHub hay nhả job trễ quanh 21h */
    const pad = x => String(x).padStart(2, "0");
    const vn = new Date(Date.now() + 7 * 3600 * 1000);
    const mins = vn.getUTCHours() * 60 + vn.getUTCMinutes();
    let slot = null, base = vn;
    for (const h in SLOTS) { if (mins >= h * 60 && mins < h * 60 + SLOTS[h]) slot = +h; }
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
  const out = await REPORTS[r](q);
  const text = typeof out === "string" ? out : out.text;
  const chart = (typeof out === "object" && out.chart) || null;
  if (q.dry) { res.setHeader("Content-Type", "text/plain; charset=utf-8"); res.status(200).send(text + (chart ? "\n\n[có kèm biểu đồ " + chart.data.labels.length + " ngày × " + chart.data.datasets.length + " loại đơn]" : "")); return; }
  const token = process.env.TELEGRAM_BOT_TOKEN, boxes = targets();
  if (!token || !boxes.length) { res.status(200).json({ error: "telegram_not_configured", need: ["TELEGRAM_BOT_TOKEN", "TELEGRAM_CHAT_ID"] }); return; }
  const api = (m, b, thread) => fetch("https://api.telegram.org/bot" + token + "/" + m, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify(thread ? Object.assign({ message_thread_id: thread }, b) : b)
  }).then(x => x.json());
  try {
    const img = (chart && q.noimg !== "1") ? await chartURL(chart) : null; /* render 1 lần, dùng chung mọi box */
    const sent = [];
    for (const b of boxes) {
      let j = null, photo = false;
      if (img) { /* ảnh + chú thích; chú thích Telegram giới hạn 1024 ký tự */
        if (text.length <= 1000) j = await api("sendPhoto", { chat_id: b.chat, photo: img, caption: text, parse_mode: "HTML" }, b.thread);
        else {
          j = await api("sendPhoto", { chat_id: b.chat, photo: img, caption: text.split("\n").slice(0, 3).join("\n"), parse_mode: "HTML" }, b.thread);
          if (j && j.ok) j = await api("sendMessage", { chat_id: b.chat, text, parse_mode: "HTML", disable_web_page_preview: true }, b.thread);
        }
        photo = !!(j && j.ok);
      }
      if (!j || !j.ok) j = await api("sendMessage", { chat_id: b.chat, text, parse_mode: "HTML", disable_web_page_preview: true }, b.thread);
      sent.push({ chat: b.chat, ok: !!(j && j.ok), photo, error: j && j.ok ? undefined : (j && j.description) });
    }
    const anyOk = sent.some(x => x.ok);
    if (!anyOk && markKey) await kv(["DEL", markKey]); /* không box nào nhận được thì nhả khung để lần gõ cửa sau thử lại */
    res.status(200).json(anyOk ? { ok: true, report: r, boxes: sent } : { ok: false, boxes: sent });
  } catch (e) {
    if (markKey) await kv(["DEL", markKey]);
    res.status(502).json({ ok: false, error: "" + (e && e.message ? e.message : e) });
  }
};
