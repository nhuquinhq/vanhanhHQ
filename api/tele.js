// Vercel Serverless Function — Bot bắn báo cáo dashboard vào box Telegram
// Gọi: /api/tele?r=pvh10[&d=17/07][&dry=1][&key=<TELE_SECRET>][&slot=auto]
//  - GitHub Actions gõ cửa nhiều lần quanh mỗi khung giờ với slot=auto → server tự quyết theo GIỜ VN:
//    đúng khung 12h/18h/23h (trong 3 tiếng sau mốc) mới gửi, mỗi khung chỉ gửi 1 lần (đánh dấu KV).
//    Lý do: bộ hẹn giờ GitHub hay trễ vô chừng (có hôm job 12h trưa bị nhả lúc 3h sáng).
//  - dry=1: chỉ trả về nội dung để xem thử, KHÔNG gửi
//  - Env cần có: TELEGRAM_BOT_TOKEN · TELEGRAM_CHAT_ID · (tuỳ chọn) TELEGRAM_THREAD_ID, TELE_SECRET
const FILE_SLA = "2PACX-1vRHGRhq3zSjBYecJRUbTLwlgjvx-A7hIu8J0eSkUKuXZI7uMWYLjyUeIKefumrnQLC5jIbW55y0lE1W";
/* các file publish khác — chỉ dùng cho lệnh soi ?diag để tìm xem tab nằm ở file nào */
const FILES_ALL = {
  sla: FILE_SLA,
  def: "2PACX-1vSe-ef8TakONHHOrCz3zef2l8rbluKBwRFmOOIJKDXjU62zI91CM-9sPobr0kxyDUkNBmg3UA8Zssgn",
  def_old: "2PACX-1vSve6XRHg5gWRzqkazHm5zvlrkTkAMLa7TJms_U-ebAFcrDAmcvCYfNJ50hrvV988tXyKC7q70LQgPc",
  gc13: "2PACX-1vSlOzVTuSNAfW-lVKF7xjLAPwVtnebtOFxCDiJKaseD8xQ9NfRpAWRQG-ivkUSMM83Tf1Ea2xnnRX_4",
  ton: "2PACX-1vQToyJFyIIxiDtucrAhxnTVZmjNWF2InPci5r-C75DfkHR6aQbUrmZNBcwDDadNrET82VwxtdjDhITE",
  kho: "2PACX-1vRdHQpyZ6zwGPYrrPX51UWzlHKunxOiHOCofQHSaCK_DCu_7-FZ-gdD-sVDT3t5uoYglVmggXDtziz5"
};
const GIDS = { tc: "1496740945", gp_ngay: "511745866", ns: "423402286" /* Năng suất Nhân viên */ };

/* Danh sách box nhận báo cáo.
   - TELEGRAM_CHAT_ID (+ TELEGRAM_THREAD_ID)  : box 1
   - TELEGRAM_CHAT_ID_2 (+ TELEGRAM_THREAD_ID_2), _3, _4 …: các box thêm
   - TELEGRAM_TARGETS: khai báo gọn nhiều box một dòng "chatid:topicid,chatid,…" (ưu tiên nếu có) */
const parseBoxes = T => T.split(/[,;\s]+/).filter(Boolean).map(x => {
  const p = x.split(":"); return { chat: p[0], thread: p[1] ? +p[1] : null };
});
function targets() {
  const T = (process.env.TELEGRAM_TARGETS || "").trim();
  if (T) return parseBoxes(T);
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
/* tone màu biểu đồ: xanh ngọc · san hô · xanh lá · kem — dùng chung cho mọi ảnh bot gửi */
const PAL = ["#357D71", "#FA8A89", "#638A55", "#C48D60", "#C2CB81", "#9BBA74", "#E1B083", "#B3564F", "#FDACBB", "#7FBFB2"];
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
    /* xếp theo số đơn NHIỀU → ÍT cho dễ đọc */
    const day = P.types.map(t => ({ name: t.name, v: t.daily[key] || 0 })).sort((a, b) => b.v - a.v);
    const dTot = day.reduce((a, x) => a + x.v, 0);
    lines.push("", "🧮 <b>Đơn thủ công trong ngày: " + fmt(dTot) + "</b>");
    day.forEach(x => lines.push(" • " + x.name + ": " + fmt(x.v)));
    const mm = key.slice(0, 2);
    const cum = P.types.map(t => ({ name: t.name, v: Object.keys(t.daily).filter(k => k.slice(0, 2) === mm && k <= key).reduce((a, k) => a + t.daily[k], 0) })).sort((a, b) => b.v - a.v);
    const cTot = cum.reduce((a, x) => a + x.v, 0);
    const nDays = P.dateCols.filter(c => c.dk.slice(0, 2) === mm && c.dk <= key && P.types.some(t => t.daily[c.dk] != null)).length;
    lines.push("", "📈 Lũy kế tháng " + (+mm) + ": <b>" + fmt(cTot) + " đơn</b>" + (P.kpi ? " · KPI " + P.kpi : ""));
    cum.forEach(x => lines.push(" • " + x.name + ": " + fmt(x.v) + (cTot ? " (" + pct(x.v / cTot) + ")" : "")));
    if (nDays) lines.push(" • Bình quân: " + fmt(cTot / nDays) + " đơn/ngày");
    /* biểu đồ cột chồng: các ngày trong tháng tới ngày báo cáo */
    const days = P.dateCols.map(c => c.dk).filter((k, i, a) => k.slice(0, 2) === mm && k <= key && a.indexOf(k) === i).sort();
    const rank = {}; cum.forEach(x => rank[x.name] = x.v);
    const used = P.types.filter(t => days.some(k => (t.daily[k] || 0) > 0)).sort((a, b) => (rank[b.name] || 0) - (rank[a.name] || 0));
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


/* ---- tab "Năng suất Nhân viên": hàng = NGÀY, cột = (loại xử lý × nhân viên) ----
   Khuôn: hàng nhóm (MUA GIFTCARD · MUA ROBUX · XLĐ ROBUX · XLĐ GAMOTA · XLĐ POKEMON…) nằm ngay
   trên hàng tên nhân viên; ô gộp để trống nên điền xuôi sang phải. */
/* Một người có thể có nhiều tài khoản trên sheet: QTVTienHT1 / qtvtienht2, qtvdiunt / QTVDiuNTPCU,
   qtvlinhptt / QTVLinhPTTPCU… → quy về một mối: bỏ tiền tố QTV/CTV, đuôi PCU và số thứ tự cuối tên. */
function canonEmp(s) {
  const k = nrm(s).toLowerCase().replace(/\s+/g, "").replace(/^(qtv|ctv)/, "").replace(/pcu$/, "").replace(/\d+$/, "");
  return k || nrm(s).toLowerCase();
}
function parseNS(rows) {
  const W = Math.max.apply(null, rows.slice(0, 80).map(r => (r || []).length).concat([0]));
  const isD = v => /^\d{1,2}\/\d{1,2}(\/\d{2,4})?$/.test(nrm(v));
  const isTot = v => /^(t[ổo]ng|total|sum|c[ộo]ng|t[ổo]ng\s*c[ộo]ng)/i.test(nrm(v)); /* bỏ cột/hàng TỔNG kẻo đếm 2 lần */
  let dCol = -1, dHits = 0;
  for (let c = 0; c < Math.min(W, 8); c++) {
    let h = 0; for (let r = 0; r < rows.length; r++) if (isD((rows[r] || [])[c])) h++;
    if (h > dHits) { dHits = h; dCol = c; }
  }
  if (dCol < 0 || dHits < 5) return null;
  const first = rows.findIndex(r => isD((r || [])[dCol]));
  /* hàng tên nhân viên = hàng nhiều ô CHỮ nhất trong 8 hàng ngay trên vùng dữ liệu */
  let HR = -1, best = 0;
  for (let r = Math.max(0, first - 8); r < first; r++) {
    const row = rows[r] || []; let n = 0;
    for (let c = dCol + 1; c < W; c++) { const v = nrm(row[c]); if (v && /[a-zA-ZÀ-ỹ]/.test(v) && !/^\d/.test(v)) n++; }
    if (n > best) { best = n; HR = r; }
  }
  if (HR < 0 || best < 3) return null;
  /* hàng nhóm: hàng gần nhất phía trên có từ 2 NHÃN CHỮ trở lên (hàng tổng toàn số thì bỏ qua) */
  const isLab = v => !!v && /[a-zA-ZÀ-ỹ]/.test(v) && !/^\d/.test(v);
  let GR = -1;
  for (let r = HR - 1; r >= Math.max(0, HR - 4); r--) {
    const row = rows[r] || []; let n = 0;
    for (let c = dCol + 1; c < W; c++) if (isLab(nrm(row[c]))) n++;
    if (n >= 2) { GR = r; break; }
  }
  /* ô gộp: kéo tên nhóm sang phải — CHỈ nhận ô có chữ, ô số (tổng của nhóm) không được coi là tên nhóm */
  const groups = [], emps = []; let cur = "";
  for (let c = 0; c < W; c++) {
    const g = GR >= 0 ? nrm((rows[GR] || [])[c]) : ""; if (isLab(g) && !isTot(g)) cur = g;
    groups[c] = cur; emps[c] = nrm((rows[HR] || [])[c]);
  }
  const cols = [];
  for (let c = dCol + 1; c < W; c++) if (emps[c] && /[a-zA-ZÀ-ỹ]/.test(emps[c]) && !/^\d/.test(emps[c]) && !isTot(emps[c]) && !isTot(groups[c]))
    cols.push({ c, emp: emps[c], key: canonEmp(emps[c]), grp: groups[c] || "Khác" });
  if (!cols.length) return null;
  const byDayGrp = {}, byEmp = {}, byDay = {}, byDayEmpGrp = {}, grpOrder = [], rawTot = {};
  for (let r = first; r < rows.length; r++) {
    const row = rows[r] || []; const d = nrm(row[dCol]); if (!isD(d)) continue;
    const p = d.split("/"); const dk = p[1].padStart(2, "0") + "-" + p[0].padStart(2, "0");
    cols.forEach(x => {
      const v = vnum(row[x.c]); if (!(v > 0)) return;
      (byDayGrp[dk] = byDayGrp[dk] || {})[x.grp] = (byDayGrp[dk][x.grp] || 0) + v;
      (byEmp[dk] = byEmp[dk] || {})[x.key] = (byEmp[dk][x.key] || 0) + v;
      /* chi tiết từng người làm gì trong ngày: byDayEmpGrp[ngày][tên][loại] */
      const de = (byDayEmpGrp[dk] = byDayEmpGrp[dk] || {});
      (de[x.key] = de[x.key] || {})[x.grp] = (de[x.key][x.grp] || 0) + v;
      byDay[dk] = (byDay[dk] || 0) + v;
      rawTot[x.emp] = (rawTot[x.emp] || 0) + v;
      if (grpOrder.indexOf(x.grp) < 0) grpOrder.push(x.grp);
    });
  }
  if (!Object.keys(byDay).length) return null;
  /* tên hiển thị của mỗi người = tài khoản có nhiều đơn nhất (hoà thì lấy tên ngắn hơn) */
  const disp = {};
  Object.keys(rawTot).forEach(raw => {
    const k = canonEmp(raw), cur = disp[k];
    if (!cur || rawTot[raw] > rawTot[cur] || (rawTot[raw] === rawTot[cur] && raw.length < cur.length)) disp[k] = raw;
  });
  const renName = k => disp[k] || k;
  Object.keys(byEmp).forEach(dk => {
    const o = byEmp[dk], n = {};
    Object.keys(o).forEach(k => { const t = renName(k); n[t] = (n[t] || 0) + o[k]; });
    byEmp[dk] = n;
  });
  Object.keys(byDayEmpGrp).forEach(dk => {
    const o = byDayEmpGrp[dk], n = {};
    Object.keys(o).forEach(k => {
      const t = renName(k), s = (n[t] = n[t] || {});
      Object.keys(o[k]).forEach(g => s[g] = (s[g] || 0) + o[k][g]);
    });
    byDayEmpGrp[dk] = n;
  });
  return { byDayGrp, byEmp, byDay, byDayEmpGrp, grpOrder, nEmp: Object.keys(disp).length,
           dbg: { dCol, HR, GR, first, cols: cols.map(x => ({ c: x.c, emp: x.emp, grp: x.grp })) } };
}

/* ---- báo cáo năng suất nhân viên: 2 biểu đồ ---- */
async function buildNS(q) {
  const rows = await readTab(GIDS.ns);
  const now = new Date(Date.now() + 7 * 3600 * 1000);
  let dd = now.getUTCDate(), mo = now.getUTCMonth() + 1;
  const md = q.d && ("" + q.d).match(/^(\d{1,2})\/(\d{1,2})$/); if (md) { dd = +md[1]; mo = +md[2]; }
  let key = String(mo).padStart(2, "0") + "-" + String(dd).padStart(2, "0");
  const lines = ["👥 <b>Năng suất nhân viên — Phòng vận hành</b>"];
  const P = rows ? parseNS(rows) : null;
  /* không đọc được thì IM LẶNG (trả lý do trong log) — tránh bắn tin lỗi vào box */
  if (!P) return { skip: 'khong_doc_duoc_tab_nang_suat_nhan_vien_kiem_tra_publish_to_web' };
  const avail = Object.keys(P.byDay).filter(k => P.byDay[k] > 0).sort();
  if (avail.length && avail.indexOf(key) < 0) { const past = avail.filter(k => k <= key); key = past.length ? past[past.length - 1] : avail[avail.length - 1]; }
  const mm = key.slice(0, 2);
  const days = avail.filter(k => k.slice(0, 2) === mm && k <= key);
  lines.push("🗓 Ngày " + key.slice(3) + "/" + mm + "/2026");
  const dG = P.byDayGrp[key] || {};
  /* cơ cấu theo loại đơn KHÔNG nhắc lại ở đây — đã có ở báo cáo PVH10 bắn ngay phía trên */
  lines.push("", "🧮 <b>Đơn xử lý trong ngày: " + fmt(P.byDay[key] || 0) + "</b>");
  /* ai làm gì trong ngày — trả lời thẳng "Thuỳ mua bao nhiêu giftcard, bao nhiêu robux…" */
  const dEmp = P.byDayEmpGrp[key] || {};
  const sumOf = o => Object.keys(o).reduce((t, g) => t + o[g], 0);
  const dList = Object.keys(dEmp).sort((a, b) => sumOf(dEmp[b]) - sumOf(dEmp[a]));
  const gShort = g => g.replace(/^XL[ĐD]\s*/i, "").replace(/^MUA\s+/i, "Mua ");
  if (dList.length) {
    lines.push("", "👤 <b>Trong ngày theo nhân viên</b>");
    dList.slice(0, 12).forEach(e => {
      const o = dEmp[e], gs = Object.keys(o).sort((a, b) => o[b] - o[a]);
      lines.push(" • " + e + ": <b>" + fmt(sumOf(o)) + "</b> (" + gs.map(g => gShort(g) + " " + fmt(o[g])).join(" · ") + ")");
    });
    if (dList.length > 12) lines.push(" … và " + (dList.length - 12) + " nhân sự khác (xem biểu đồ)");
  }
  const emp = {}, empGrp = {}, mGrp = {};
  days.forEach(k => {
    Object.keys(P.byEmp[k] || {}).forEach(e => emp[e] = (emp[e] || 0) + P.byEmp[k][e]);
    const d = P.byDayEmpGrp[k] || {};
    Object.keys(d).forEach(e => {
      const s = (empGrp[e] = empGrp[e] || {});
      Object.keys(d[e]).forEach(g => { s[g] = (s[g] || 0) + d[e][g]; mGrp[g] = (mGrp[g] || 0) + d[e][g]; });
    });
  });
  const cTot = days.reduce((a, k) => a + P.byDay[k], 0);
  lines.push("", "📈 Lũy kế tháng " + (+mm) + ": <b>" + fmt(cTot) + " đơn</b> · " + P.nEmp + " nhân sự · BQ " + fmt(cTot / (days.length || 1)) + " đơn/ngày");
  const top = Object.keys(emp).sort((a, b) => emp[b] - emp[a]);
  lines.push("", "🏅 <b>Top nhân sự tháng " + (+mm) + "</b>");
  top.slice(0, 5).forEach((e, i) => lines.push(" " + ["🥇", "🥈", "🥉", "4.", "5."][i] + " " + e + ": " + fmt(emp[e]) + (cTot ? " (" + pct(emp[e] / cTot) + ")" : "")));
  const dom = process.env.DASH_URL || (process.env.VERCEL_PROJECT_PRODUCTION_URL ? "https://" + process.env.VERCEL_PROJECT_PRODUCTION_URL : "");
  if (dom) lines.push("", "🔗 Chi tiết: " + dom);
  const charts = [];
  /* biểu đồ 1 — TRONG NGÀY: mỗi nhân viên một cột, chồng theo loại xử lý (ai mua giftcard bao nhiêu,
     robux bao nhiêu, xử lý đơn loại nào…) — xếp người nhiều đơn nhất trước */
  const dE = P.byDayEmpGrp[key] || {};
  const dEmps = Object.keys(dE).sort((a, b) => {
    const s = o => Object.keys(o).reduce((t, g) => t + o[g], 0);
    return s(dE[b]) - s(dE[a]);
  });
  const dGrps = P.grpOrder.filter(g => dG[g]).sort((a, b) => dG[b] - dG[a]);
  if (dEmps.length) charts.push({
    type: "bar",
    data: {
      labels: dEmps,
      datasets: dGrps.map((g, i) => ({ label: g, data: dEmps.map(e => (dE[e] || {})[g] || 0), backgroundColor: PAL[i % PAL.length] }))
    },
    options: {
      title: { display: true, text: "Năng suất xử lý đơn theo nhân viên — ngày " + key.slice(3) + "/" + mm + " · tổng " + fmt(P.byDay[key] || 0) + " đơn", fontSize: 16 },
      legend: { position: "bottom", labels: { boxWidth: 12, fontSize: 11 } },
      scales: {
        xAxes: [{ stacked: true, ticks: { fontSize: 10, minRotation: 45, maxRotation: 60 } }],
        yAxes: [{ stacked: true, ticks: { beginAtZero: true } }]
      }
    }
  });
  /* không vẽ lại biểu đồ đơn theo ngày × loại: PVH10 đã có */
  const tv = top.slice(0, 18);
  const mGrps = Object.keys(mGrp).sort((a, b) => mGrp[b] - mGrp[a]);
  if (tv.length) charts.push({
    type: "horizontalBar",
    data: {
      labels: tv,
      datasets: mGrps.map((g, i) => ({ label: g, data: tv.map(e => (empGrp[e] || {})[g] || 0), backgroundColor: PAL[i % PAL.length] }))
    },
    options: {
      title: { display: true, text: "Tổng đơn xử lý tháng " + (+mm) + "/2026 — so sánh giữa nhân viên", fontSize: 16 },
      legend: { position: "bottom", labels: { boxWidth: 12, fontSize: 11 } },
      scales: { xAxes: [{ stacked: true, ticks: { beginAtZero: true } }], yAxes: [{ stacked: true, ticks: { fontSize: 11 } }] }
    }
  });
  return { text: lines.join("\n"), charts };
}

const REPORTS = { pvh10: buildPVH10, nv: buildNS };
/* Báo cáo nào gửi vào box nào:
   - mặc định: gửi mọi box đã khai (PVH10 đang gửi cả box PVH lẫn box PCU)
   - báo cáo nội bộ (năng suất nhân viên) chỉ gửi BOX 1 cho tới khi khai rõ TELE_BOXES_NV="chatid:topicid,…" */
const R_BOX1 = { nv: 1 };
function boxesFor(r) {
  const E = (process.env["TELE_BOXES_" + r.toUpperCase()] || "").trim();
  if (E) return parseBoxes(E);
  const all = targets();
  return R_BOX1[r] ? all.slice(0, R_BOX1[r]) : all;
}

module.exports = async (req, res) => {
  const q = req.query || {};
  /* ?peek=1 — trang tra cứu chat id / topic id: gõ tin trong đúng topic rồi mở link này.
     Chỉ trả về id + tên box, KHÔNG hiện nội dung tin nhắn. */
  if (q.peek) {
    const token0 = process.env.TELEGRAM_BOT_TOKEN;
    if (!token0) { res.status(200).send("Chua khai bao TELEGRAM_BOT_TOKEN"); return; }
    let out = "";
    try {
      const rr = await fetch("https://api.telegram.org/bot" + token0 + "/getUpdates?limit=100&t=" + Date.now());
      const jj = await rr.json();
      if (!jj.ok) { res.setHeader("Content-Type", "text/plain; charset=utf-8"); res.setHeader("Cache-Control", "no-store");
        res.status(200).send("Telegram tra ve loi: " + (jj.description || JSON.stringify(jj)) +
          "\n(Neu bao 'terminated by other getUpdates request' thi doi 5 giay roi tai lai; neu bao webhook thi bot dang dung webhook.)"); return; }
      const seen = {}, rows = [];
      (jj.result || []).slice().reverse().forEach(u => { /* mới nhất lên đầu */
        const m = u.message || u.channel_post || u.edited_message; if (!m || !m.chat) return;
        const th = m.message_thread_id || (m.is_topic_message ? 1 : null);
        const k = m.chat.id + "/" + (th || "-");
        if (seen[k]) return; seen[k] = 1;
        rows.push({ chat_id: m.chat.id, ten_box: m.chat.title || m.chat.username || "(chat riêng)", topic_id: th || null,
                    topic: m.reply_to_message && m.reply_to_message.forum_topic_created ? m.reply_to_message.forum_topic_created.name : undefined,
                    luc: new Date((m.date + 7 * 3600) * 1000).toISOString().replace("T", " ").slice(5, 16) + " (giờ VN)" });
      });
      out = rows.length
        ? "CAC BOX BOT VUA NHAN DUOC TIN (" + (jj.result || []).length + " tin dang cho, moi nhat len dau):\n\n" + rows.map(x => JSON.stringify(x)).join("\n") +
          "\n\nCach dung: TELEGRAM_CHAT_ID_2 = chat_id · TELEGRAM_THREAD_ID_2 = topic_id (bo qua neu topic_id = null)."
        : "Chua thay tin nao. Hay go '@bcpvh_bot test' NGAY TRONG topic muon nhan bao cao roi tai lai trang nay.\n" +
          "(Bot chi 'thay' tin trong nhom khi tin do nhac ten bot hoac la lenh /...)";
    } catch (e) { out = "Loi goi Telegram: " + (e && e.message ? e.message : e); }
    res.setHeader("Content-Type", "text/plain; charset=utf-8");
    res.setHeader("Cache-Control", "no-store, max-age=0"); /* tranh trinh duyet giu ban cu */
    res.status(200).send(out + "\n\nXem luc: " + new Date(Date.now() + 7 * 3600 * 1000).toISOString().replace("T", " ").slice(5, 16) + " (gio VN)"); return;
  }
  const SECRET = process.env.TELE_SECRET || "";
  const isCron = !!req.headers["x-vercel-cron"] || /vercel-cron/i.test(req.headers["user-agent"] || "");
  if (SECRET && !isCron && q.key !== SECRET) { res.status(401).json({ error: "unauthorized" }); return; }
  if (isCron && !q.slot && !q.dry) q.slot = "auto"; /* Vercel Cron gọi trần /api/tele → tự đi qua gác giờ VN */
  /* ?diag=<gid> — soi xem tab đó nằm ở file publish nào, đọc ra gì (chẩn đoán khi báo cáo bị bỏ qua) */
  if (q.diag) {
    const gid = String(q.diag).replace(/\D/g, "") || GIDS.ns;
    const rp = [];
    for (const f of Object.keys(FILES_ALL)) {
      const u = "https://docs.google.com/spreadsheets/d/e/" + FILES_ALL[f] + "/pub?gid=" + gid + "&single=true&output=csv";
      try {
        const rr = await fetch(u, { redirect: "follow" });
        const t = await rr.text();
        const html = t.trimStart().slice(0, 200).toLowerCase().startsWith("<");
        const rows = html ? [] : csvParse(t);
        rp.push("[" + f + "] http=" + rr.status + " dai=" + t.length + (html ? " KIEU=HTML(tab chua duoc publish)" : " so_dong=" + rows.length) +
                "\n   " + t.replace(/\s+/g, " ").slice(0, 160));
        if (!html && rows.length > 3) {
          const P = parseNS(rows);
          rp.push("   doc_duoc: " + (P ? Object.keys(P.byDay).length + " ngay, " + P.nEmp + " nhan su, nhom: " + P.grpOrder.join(" | ") : "KHONG (bo doc khong nhan ra khuon)"));
          if (P && P.dbg) {
            rp.push("   dCol=" + P.dbg.dCol + " HR(ten nv)=" + P.dbg.HR + " GR(nhom)=" + P.dbg.GR + " dong du lieu dau=" + P.dbg.first);
            for (let r = Math.max(0, P.dbg.GR - 3); r <= P.dbg.HR + 1; r++)
              rp.push("   [dong " + r + "] " + (rows[r] || []).map((v, i) => i + ":" + nrm(v)).filter(x => x.split(":")[1]).slice(0, 40).join("  "));
            rp.push("   cot nhan vien -> nhom: " + P.dbg.cols.map(x => x.c + ":" + x.emp + "=" + x.grp).join("  "));
          }
        }
      } catch (e) { rp.push("[" + f + "] loi: " + (e && e.message ? e.message : e)); }
    }
    res.setHeader("Content-Type", "text/plain; charset=utf-8"); res.setHeader("Cache-Control", "no-store");
    res.status(200).send("SOI TAB gid=" + gid + "\n\n" + rp.join("\n")); return;
  }
  /* r có thể liệt kê nhiều báo cáo: ?r=pvh10,nv — mặc định lấy env TELE_REPORTS */
  const rs = ("" + (q.r || process.env.TELE_REPORTS || "pvh10,nv")).toLowerCase().split(/[,;\s]+/).filter((x, i, a) => x && a.indexOf(x) === i);
  const unknown = rs.filter(x => !REPORTS[x]);
  if (!rs.length || unknown.length) { res.status(400).json({ error: "unknown_report", unknown, reports: Object.keys(REPORTS) }); return; }
  /* slot=auto: gác giờ VN — chỉ gửi trong khung [mốc, mốc+3h), mỗi khung 1 lần/ngày */
  let slotN = null, slotBase = null;
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
    if (!KV_URL || !KV_TOKEN) {
      /* không có KV thì không chống trùng được — chỉ nhận lần gõ trong giờ đầu của khung */
      if (mins >= slot * 60 + 60 && !(slot === 23 && mins < 120)) { res.status(200).json({ ok: true, skip: "kv_chua_cau_hinh_qua_gio_dau" }); return; }
    }
    slotN = slot; slotBase = base;
  }
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!q.dry && (!token || !targets().length)) { res.status(200).json({ error: "telegram_not_configured", need: ["TELEGRAM_BOT_TOKEN", "TELEGRAM_CHAT_ID"] }); return; }
  const api = (m, b, thread) => fetch("https://api.telegram.org/bot" + token + "/" + m, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify(thread ? Object.assign({ message_thread_id: thread }, b) : b)
  }).then(x => x.json());
  const pad2 = x => String(x).padStart(2, "0");
  const done = [], preview = [];
  for (const r of rs) {
    /* mỗi báo cáo có dấu riêng cho từng khung giờ → báo cáo này gửi rồi không chặn báo cáo kia */
    let markKey = null;
    if (slotN != null && KV_URL && KV_TOKEN) {
      markKey = "pvh:tele:" + slotBase.getUTCFullYear() + "-" + pad2(slotBase.getUTCMonth() + 1) + "-" + pad2(slotBase.getUTCDate()) + ":" + slotN + "h:" + r;
      const got = await kv(["SET", markKey, "1", "NX", "EX", 172800]); /* NX: chỉ lần gõ cửa đầu tiên của khung được gửi */
      if (got !== "OK") { done.push({ report: r, skip: "khung_" + slotN + "h_da_gui" }); continue; }
    }
    let out;
    try { out = await REPORTS[r](q); }
    catch (e) { if (markKey) await kv(["DEL", markKey]); done.push({ report: r, ok: false, error: "" + (e && e.message ? e.message : e) }); continue; }
    if (out && out.skip) { if (markKey) await kv(["DEL", markKey]); done.push({ report: r, skip: out.skip }); if (q.dry) preview.push("=== " + r + " === (bỏ qua: " + out.skip + ")"); continue; }
    const text = typeof out === "string" ? out : out.text;
    const cfgs = (typeof out === "object" && (out.charts || (out.chart ? [out.chart] : []))) || [];
    if (q.dry) { preview.push("=== " + r + " ===\n" + text + (cfgs.length ? "\n\n[kèm " + cfgs.length + " biểu đồ: " + cfgs.map(c => c.data.labels.length + "×" + c.data.datasets.length).join(", ") + "]" : "")); continue; }
    try {
      /* render ảnh 1 lần, dùng chung cho mọi box */
      const imgs = (q.noimg === "1" ? [] : await Promise.all(cfgs.map(chartURL))).filter(Boolean);
      const sent = [], boxes = boxesFor(r);
      for (const b of boxes) {
        let j = null, photo = false;
        if (imgs.length >= 2) { /* nhiều ảnh → gửi thành 1 album */
          const media = imgs.map((u, i) => Object.assign({ type: "photo", media: u },
            i === 0 && text.length <= 1000 ? { caption: text, parse_mode: "HTML" } : {}));
          j = await api("sendMediaGroup", { chat_id: b.chat, media }, b.thread);
          photo = !!(j && j.ok);
          if (photo && text.length > 1000) j = await api("sendMessage", { chat_id: b.chat, text, parse_mode: "HTML", disable_web_page_preview: true }, b.thread);
        } else if (imgs.length === 1) { /* ảnh + chú thích; chú thích Telegram giới hạn 1024 ký tự */
          if (text.length <= 1000) j = await api("sendPhoto", { chat_id: b.chat, photo: imgs[0], caption: text, parse_mode: "HTML" }, b.thread);
          else {
            j = await api("sendPhoto", { chat_id: b.chat, photo: imgs[0], caption: text.split("\n").slice(0, 3).join("\n"), parse_mode: "HTML" }, b.thread);
            if (j && j.ok) j = await api("sendMessage", { chat_id: b.chat, text, parse_mode: "HTML", disable_web_page_preview: true }, b.thread);
          }
          photo = !!(j && j.ok);
        }
        if (!j || !j.ok) j = await api("sendMessage", { chat_id: b.chat, text, parse_mode: "HTML", disable_web_page_preview: true }, b.thread);
        sent.push({ chat: b.chat, ok: !!(j && j.ok), photo, error: j && j.ok ? undefined : (j && j.description) });
      }
      const anyOk = sent.some(x => x.ok);
      if (!anyOk && markKey) await kv(["DEL", markKey]); /* không box nào nhận được thì nhả khung để lần gõ cửa sau thử lại */
      done.push({ report: r, ok: anyOk, anh: imgs.length, boxes: sent });
    } catch (e) {
      if (markKey) await kv(["DEL", markKey]);
      done.push({ report: r, ok: false, error: "" + (e && e.message ? e.message : e) });
    }
  }
  if (q.dry) { res.setHeader("Content-Type", "text/plain; charset=utf-8"); res.status(200).send(preview.join("\n\n")); return; }
  res.status(200).json({ ok: done.some(x => x.ok), ket_qua: done });
};
