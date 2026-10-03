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
  kho: "2PACX-1vRdHQpyZ6zwGPYrrPX51UWzlHKunxOiHOCofQHSaCK_DCu_7-FZ-gdD-sVDT3t5uoYglVmggXDtziz5",
  /* HQS — BẢNG TỶ GIÁ HÀNG TUẦN: tỷ giá tính giá nhập là hàng "USDT/VND · CO Rate" */
  fx: "2PACX-1vRBzYH7dMHHBU1PhVf368oCNlLhKhGFclc4VuH9nucqShlrk5fxbYtUUBUUAbYXzm7c3nXO6P7Yb9vQ"
};
const GIDS = { tc: "1496740945", gp_ngay: "511745866", ns: "423402286" /* Năng suất Nhân viên */ };
/* Từ T10/2026 năng suất đọc ở file RIÊNG "Báo cáo Năng Suất Xử lý đơn 2026", tab "BC đơn":
   đơn chia THỦ CÔNG (mua giftcard · nạp game) và TỰ ĐỘNG (tool mua giftcard).
   Link xuất bản chị gửi 02/10 dùng CHUNG khoá publish với file SLA (…C5jIbW55y0lE1W), tab gid 752626108.
   Đổi khoá/ tab bằng biến môi trường BC_PUB_KEY / BC_GID trên Vercel, không cần sửa code. */
const FILE_BC = (process.env.BC_PUB_KEY || FILE_SLA).trim();
const GID_BC = (process.env.BC_GID || "752626108").trim();

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
/* ô trống / thiếu phải ra CHUỖI RỖNG — trước đây nrm(undefined) ra chữ "undefined" nên hàng tiêu đề
   ngắn hơn các hàng khác bị đếm nhầm là hàng nhiều chữ nhất → chọn sai hàng tên nhân viên */
const nrm = x => { if (x == null) return ""; try { x = ("" + x).normalize("NFC"); } catch (e) { x = "" + x; } return x.replace(/ /g, " ").replace(/\s+/g, " ").trim(); };
function vnum(x) {
  if (x == null) return 0; x = ("" + x).replace(/["\s₫đ$%]/g, ""); if (x === "" || x === "-") return 0;
  if (x.indexOf(",") > -1 && x.indexOf(".") === -1) x = x.replace(",", ".");
  else if (x.indexOf(",") > -1) { if (x.lastIndexOf(",") > x.lastIndexOf(".")) x = x.replace(/\./g, "").replace(",", "."); else x = x.replace(/,/g, ""); }
  else if ((x.match(/\./g) || []).length > 1 || /^-?\d{1,3}(\.\d{3})+$/.test(x)) x = x.replace(/\./g, "");
  const n = parseFloat(x); return isNaN(n) ? 0 : n;
}
const fmt = n => Math.round(n).toLocaleString("vi-VN");
const pad2 = x => String(x).padStart(2, "0");
/* bỏ dấu tiếng Việt để so khớp cho dễ (dùng trong bộ lọc của lệnh soi) */
const stripD = s => { try { return ("" + s).normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/đ/g, "d").replace(/Đ/g, "D").toLowerCase(); } catch (e) { return ("" + s).toLowerCase(); } };
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
async function readTab(gid, fileKey) {
  const url = "https://docs.google.com/spreadsheets/d/e/" + (fileKey || FILE_SLA) + "/pub?gid=" + gid + "&single=true&output=csv";
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

/* Ngày cần báo cáo theo GIỜ VN. Khung 23h hay bị nhả trễ sang sau nửa đêm (vd 00h04) — lúc đó
   ngày mới chưa có đơn nào nên phải báo cáo NGÀY HÔM TRƯỚC, không bắn một bảng toàn số 0. */
function reportDay(q) {
  const now = new Date(Date.now() + 7 * 3600 * 1000); /* giờ VN (UTC+7) */
  const d = now.getUTCHours() < 6 ? new Date(now.getTime() - 24 * 3600 * 1000) : now;
  let dd = d.getUTCDate(), mo = d.getUTCMonth() + 1;
  const md = q.d && ("" + q.d).match(/^(\d{1,2})\/(\d{1,2})$/); if (md) { dd = +md[1]; mo = +md[2]; }
  return { dd, mo, key: pad2(mo) + "-" + pad2(dd), khuyaVN: now.getUTCHours() < 6 && !md };
}
/* ---- dựng nội dung báo cáo PVH10 ---- */
async function buildPVH10(q) {
  const [tcRows, gpRows] = await Promise.all([readTab(GIDS.tc), readTab(GIDS.gp_ngay)]);
  const RD = reportDay(q);
  let key = RD.key;
  const lines = ["📊 <b>PVH10 · Năng suất xử lý đơn thủ công</b>"];
  let chartCfg = null;
  const P = tcRows ? parseTC(tcRows) : null;
  if (P) {
    const avail = P.dateCols.map(c => c.dk).filter(k => P.types.some(t => t.daily[k] != null));
    if (avail.length && avail.indexOf(key) < 0) { const past = avail.filter(k => k <= key); key = past.length ? past[past.length - 1] : avail[avail.length - 1]; }
    /* ngày đó chưa có đơn nào (sheet chưa nhập, hoặc bắn ngay sau nửa đêm) → lùi về ngày gần nhất có số */
    if (!q.d) {
      const tot = k => P.types.reduce((a, t) => a + (t.daily[k] || 0), 0);
      if (!tot(key)) { const past = avail.filter(k => k < key && tot(k) > 0).sort(); if (past.length) key = past[past.length - 1]; }
    }
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
  /* Hàng nhóm xếp kiểu: [ô TỔNG của nhóm][TÊN NHÓM][... các cột nhân viên].
     Vậy khối của một nhóm BẮT ĐẦU ở cột đứng ngay TRƯỚC ô tên (nếu ô đó là số tổng),
     kéo dài tới trước khối kế tiếp — nếu lấy đúng từ ô tên thì nhóm bị lệch một cột. */
  const labs = [];
  for (let c = 0; c < W; c++) {
    const g = GR >= 0 ? nrm((rows[GR] || [])[c]) : "";
    if (!isLab(g) || isTot(g)) continue;
    const prev = c > 0 ? nrm((rows[GR] || [])[c - 1]) : "";
    labs.push({ from: (prev && !isLab(prev)) ? c - 1 : c, g });
  }
  const groups = [], emps = []; let gi = -1;
  for (let c = 0; c < W; c++) {
    while (gi + 1 < labs.length && labs[gi + 1].from <= c) gi++;
    /* ô thiếu phải coi là RỖNG — nrm(undefined) ra chuỗi "undefined" và lọt vào danh sách nhân viên */
    groups[c] = gi >= 0 ? labs[gi].g : ""; emps[c] = nrm((rows[HR] || [])[c] || "");
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
    /* tên hiển thị = tài khoản NGẮN NHẤT (Qtvthuyhtt thay vì CTVThuyHTTPCU) — chọn theo độ dài
       nên tên không đổi qua lại theo ngày; bằng nhau thì lấy tài khoản nhiều đơn hơn, rồi theo a→z */
    if (!cur || raw.length < cur.length ||
        (raw.length === cur.length && (rawTot[raw] > rawTot[cur] ||
         (rawTot[raw] === rawTot[cur] && raw.toLowerCase() < cur.toLowerCase())))) disp[k] = raw;
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

/* Tên hiển thị gọn hơn cho vài nhãn trên sheet (so khớp sau khi bỏ dấu, viết thường).
   Đổi tên băng trên sheet thì tên mới tự lên — bảng này chỉ là lớp đặt tên cho dễ đọc. */
const ALIAS_LOAI = { "don tu dong khac": "Đơn tự động Topup+RBX" };
/* ---- tab "BC đơn" (từ T10/2026): hàng = NGÀY, cột = (phân loại × nhân viên/tool) ----
   Tiêu đề xếp nhiều tầng:
     tầng trên : NĂNG SUẤT (khối tóm tắt) · NĂNG SUẤT ĐƠN THỦ CÔNG · NĂNG SUẤT ĐƠN TỰ ĐỘNG
     tầng giữa : GIFTCARD · NẠP GAME  (loại đơn trong từng phân loại)
     tầng dưới : tên nhân viên (thủ công) hoặc tên tool/nguồn (tự động)
   Ô gộp chỉ ghi ở cột đầu nên nhãn được điền xuôi sang phải. Khối "NĂNG SUẤT" chỉ là cột cộng
   lại nên BỎ QUA — chỉ nhận cột nào thuộc "ĐƠN THỦ CÔNG" hoặc "ĐƠN TỰ ĐỘNG" để khỏi đếm hai lần. */
function parseBC(rows) {
  const W = Math.max.apply(null, rows.slice(0, 60).map(r => (r || []).length).concat([0]));
  const isD = v => /^\d{1,2}\/\d{1,2}(\/\d{2,4})?$/.test(nrm(v));
  const isLab = v => !!v && /[a-zA-ZÀ-ỹ]/.test(v) && !/^\d/.test(v);
  let dCol = -1, dHits = 0;
  for (let c = 0; c < Math.min(W, 8); c++) {
    let h = 0; for (let r = 0; r < rows.length; r++) if (isD((rows[r] || [])[c])) h++;
    if (h > dHits) { dHits = h; dCol = c; }
  }
  if (dCol < 0 || dHits < 5) return null;
  const first = rows.findIndex(r => isD((r || [])[dCol]));
  /* hàng tên (nhân viên/tool) = hàng nhiều nhãn chữ nhất trong 8 hàng ngay trên vùng dữ liệu */
  let HR = -1, best = 0;
  for (let r = Math.max(0, first - 8); r < first; r++) {
    const row = rows[r] || []; let n = 0;
    for (let c = dCol + 1; c < W; c++) if (isLab(nrm(row[c] || ""))) n++;
    if (n > best) { best = n; HR = r; }
  }
  if (HR < 0 || best < 3) return null;
  /* các hàng tiêu đề phía trên hàng tên → điền xuôi để biết mỗi cột thuộc khối nào */
  const bands = [];
  for (let r = Math.max(0, HR - 4); r < HR; r++) {
    const row = rows[r] || [], fill = []; let cur = "";
    for (let c = 0; c < W; c++) { const v = nrm(row[c] || ""); if (isLab(v)) cur = v; fill[c] = cur; }
    if (fill.some(x => x)) bands.push(fill);
  }
  if (!bands.length) return null;
  const S = x => stripD(x || "");
  const cols = [];
  for (let c = dCol + 1; c < W; c++) {
    const name = nrm((rows[HR] || [])[c] || ""); if (!isLab(name)) continue;
    const path = bands.map(b => b[c] || "");
    const top = path.find(x => /don\s*(thu\s*cong|tu\s*dong)/.test(S(x)));
    if (!top) continue;                                   /* khối tóm tắt → bỏ, tránh đếm 2 lần */
    const cls = /tu\s*dong/.test(S(top)) ? "Tự động" : "Thủ công";
    /* loại đơn = băng THẤP NHẤT còn lại (ngay trên hàng tên): GIFTCARD · NẠP GAME ·
       ĐƠN THỦ CÔNG BE… — lấy nguyên nhãn của sheet nên thêm loại mới là tự nhận */
    const mid = path.slice().reverse().find(x => x && x !== top) || "";
    /* nhãn sheet viết HOA hết → chuyển về dạng câu cho dễ đọc, giữ nguyên từ viết tắt (BE, API) */
    const dep = s => nrm(s).toLowerCase().split(" ").map((w, i) => {
      const raw = nrm(s).split(" ")[i] || "";
      if (/^[A-Z0-9]{1,4}$/.test(raw)) return raw;   /* từ viết tắt thuần ASCII: BE, API, BSV… */
      return i === 0 ? w.charAt(0).toUpperCase() + w.slice(1) : w;
    }).join(" ");
    const loai = /nap\s*game/.test(S(mid)) ? "Nạp game"
               : (/giftcard/.test(S(mid)) ? "Mua giftcard"
               : (/topup|rbx|tu\s*dong\s*khac/.test(S(mid)) ? "Đơn tự động Topup+RBX"
               : (ALIAS_LOAI[S(mid)] || dep(mid) || "Khác")));
    cols.push({ c, name, key: canonEmp(name), cls, loai, nhan: cls + " · " + loai });
  }
  if (!cols.length) return null;
  const byDay = {}, byDayLoai = {}, byDayName = {}, byDayNameLoai = {}, loaiOrder = [], rawTot = {};
  for (let r = first; r < rows.length; r++) {
    const row = rows[r] || []; const d = nrm(row[dCol]); if (!isD(d)) continue;
    const p = d.split("/"); const dk = pad2(+p[1]) + "-" + pad2(+p[0]);
    cols.forEach(x => {
      const v = vnum(row[x.c]); if (!(v > 0)) return;
      byDay[dk] = (byDay[dk] || 0) + v;
      (byDayLoai[dk] = byDayLoai[dk] || {})[x.nhan] = (byDayLoai[dk][x.nhan] || 0) + v;
      (byDayName[dk] = byDayName[dk] || {})[x.key] = (byDayName[dk][x.key] || 0) + v;
      const dn = (byDayNameLoai[dk] = byDayNameLoai[dk] || {});
      (dn[x.key] = dn[x.key] || {})[x.nhan] = (dn[x.key][x.nhan] || 0) + v;
      rawTot[x.name] = (rawTot[x.name] || 0) + v;
      if (loaiOrder.indexOf(x.nhan) < 0) loaiOrder.push(x.nhan);
    });
  }
  if (!Object.keys(byDay).length) return null;
  /* tên hiển thị của mỗi người = tài khoản nhiều đơn nhất (hoà thì lấy tên ngắn hơn) */
  const disp = {};
  Object.keys(rawTot).forEach(raw => {
    const k = canonEmp(raw), cur = disp[k];
    /* tên hiển thị = tài khoản NGẮN NHẤT (Qtvthuyhtt thay vì CTVThuyHTTPCU) — chọn theo độ dài
       nên tên không đổi qua lại theo ngày; bằng nhau thì lấy tài khoản nhiều đơn hơn, rồi theo a→z */
    if (!cur || raw.length < cur.length ||
        (raw.length === cur.length && (rawTot[raw] > rawTot[cur] ||
         (rawTot[raw] === rawTot[cur] && raw.toLowerCase() < cur.toLowerCase())))) disp[k] = raw;
  });
  const ren = k => disp[k] || k;
  Object.keys(byDayName).forEach(dk => {
    const o = byDayName[dk], n = {}; Object.keys(o).forEach(k => { const t = ren(k); n[t] = (n[t] || 0) + o[k]; }); byDayName[dk] = n;
  });
  Object.keys(byDayNameLoai).forEach(dk => {
    const o = byDayNameLoai[dk], n = {};
    Object.keys(o).forEach(k => { const t = ren(k), s = (n[t] = n[t] || {}); Object.keys(o[k]).forEach(g => s[g] = (s[g] || 0) + o[k][g]); });
    byDayNameLoai[dk] = n;
  });
  const clsOf = {}; cols.forEach(x => clsOf[x.nhan] = x.cls);
  return { byDay, byDayLoai, byDayName, byDayNameLoai, loaiOrder, clsOf,
           nNguoi: new Set(cols.filter(x => x.cls === "Thủ công").map(x => x.key)).size,
           dbg: { dCol, HR, first, cols: cols.map(x => ({ c: x.c, name: x.name, nhan: x.nhan })) } };
}
/* Số MINH HOẠ để bắn thử khi file nguồn chưa được Đăng lên web (gọi với ?mau=1).
   Lấy đúng số ngày 01/10 và 02/10 trong ảnh chụp sheet — tin gửi đi có ghi rõ là tin thử. */
const MAU_BC = [
  ",,,,,,,,,,,,,,,,,,,,,,,,,,,,,,,,,,,,,",
  ",NĂNG SUẤT NHÂN VIÊN PHÒNG VẬN HÀNH,,,,,,,,,,,,,,,,,,,,,,,,,,,,,,,,,,,,",
  ",,,,,,,,,,,,,,,,,,,,,,,,,,,,,,,,,,,,,",
  ",,,,,,,,,,,,,,,,,,,,,,,,,,,,,,,,,,,,,",
  ",,,NĂNG SUẤT,,,,,,,NĂNG SUẤT ĐƠN THỦ CÔNG,,,,,,,,,,,,,,,,,NĂNG SUẤT ĐƠN TỰ ĐỘNG,,,,,,,,,,",
  ",,,THỦ CÔNG,,,TỰ ĐỘNG,,,,GIFTCARD,,,,,ĐƠN THỦ CÔNG BE,,,,NẠP GAME,,,,,,,,GIFTCARD,,,,,ĐƠN TỰ ĐỘNG KHÁC,,,,,",
  ",,,GIFTCARD,NẠP GAME,ĐƠN THỦ CÔNG KHÁC,GIFTCARD,,,,CTVThuyHTTPCU,QTVMaiCT,QTVAnhLPT,CTVLinhPTTPCU,,Qtvlinhptt,Qtvmaict,Qtvthuyhtt,Qtvanhlpt,ManhTND,TuPC,,,,,,,SEAGM API,BEP - BSV (Conggame),TRC - BSV (Conggame),,,RBX,OGGaming X,Galaxy,Gamota,Razer Gold,G-engine",
  ",,222,13,169,40,134,,,,5,,8,,,35,,5,,70,99,,,,,,,36,82,16,,,37,133,245,13,13,1",
  ",01/10,567,,,,,,,,4,,8,,,13,,5,,70,47,,,,,,,22,76,16,,,33,98,152,12,10,1",
  ",02/10,231,,,,,,,,1,,,,,22,,,,,52,,,,,,,14,6,,,,4,35,93,1,3,",
  ",03/10,,,,,,,,,,,,,,,,,,,,,,,,,,,,,,,,,,,,",
  ",04/10,,,,,,,,,,,,,,,,,,,,,,,,,,,,,,,,,,,,",
  ",05/10,,,,,,,,,,,,,,,,,,,,,,,,,,,,,,,,,,,,",
  ",06/10,,,,,,,,,,,,,,,,,,,,,,,,,,,,,,,,,,,,"
].join("\n");
/* ---- báo cáo năng suất theo PHÂN LOẠI ĐƠN (từ T10/2026) ---- */
async function buildBC(q) {
  const mau = q.mau === "1";
  if (!FILE_BC && !mau) return { skip: "chua_khai_BC_PUB_KEY_cho_file_bao_cao_nang_suat_moi" };
  const rows = mau ? csvParse(MAU_BC) : await readTab(GID_BC, FILE_BC);
  const P = rows ? parseBC(rows) : null;
  if (!P) return { skip: "khong_doc_duoc_tab_BC_don_kiem_tra_publish_to_web" };
  let key = reportDay(q).key;
  const avail = Object.keys(P.byDay).filter(k => P.byDay[k] > 0).sort();
  if (!avail.length) return { skip: "tab_BC_don_chua_co_so" };
  if (avail.indexOf(key) < 0) { const past = avail.filter(k => k <= key); key = past.length ? past[past.length - 1] : avail[avail.length - 1]; }
  const mm = key.slice(0, 2), days = avail.filter(k => k.slice(0, 2) === mm && k <= key);
  const lines = ["📊 <b>Năng suất xử lý đơn — Phòng vận hành</b>", "🗓 Ngày " + key.slice(3) + "/" + mm + "/2026"];
  if (mau) lines.splice(1, 0, "⚠️ <b>TIN THỬ — số minh hoạ</b>, file nguồn chưa Đăng lên web nên chưa nối số thật");
  const dL = P.byDayLoai[key] || {}, dTot = P.byDay[key] || 0;
  const sumCls = (o, cls) => Object.keys(o).filter(k => P.clsOf[k] === cls).reduce((a, k) => a + o[k], 0);
  const tc = sumCls(dL, "Thủ công"), td = sumCls(dL, "Tự động");
  const sub = (o, cls) => Object.keys(o).filter(k => P.clsOf[k] === cls && o[k]).sort((a, b) => o[b] - o[a])
    .map(k => " • " + k.split(" · ")[1] + ": " + fmt(o[k]));
  lines.push("", "🧮 <b>Tổng đơn trong ngày: " + fmt(dTot) + "</b>");
  lines.push("🖐 <b>Thủ công: " + fmt(tc) + "</b>" + (dTot ? " (" + pct(tc / dTot) + ")" : ""));
  lines.push.apply(lines, sub(dL, "Thủ công"));
  lines.push("🤖 <b>Tự động: " + fmt(td) + "</b>" + (dTot ? " (" + pct(td / dTot) + ")" : ""));
  lines.push.apply(lines, sub(dL, "Tự động"));
  /* ai làm gì trong ngày — tách riêng người (thủ công) và tool (tự động) */
  const dNL = P.byDayNameLoai[key] || {};
  const sumOf = o => Object.keys(o).reduce((a, k) => a + o[k], 0);
  const listOf = cls => Object.keys(dNL)
    .map(n => ({ n, v: Object.keys(dNL[n]).filter(k => P.clsOf[k] === cls).reduce((a, k) => a + dNL[n][k], 0), o: dNL[n] }))
    .filter(x => x.v > 0).sort((a, b) => b.v - a.v);
  const short = k => k.split(" · ")[1];
  const nguoi = listOf("Thủ công");
  /* TIN 2 — năng suất nhân viên, tách riêng khỏi tin phân loại đơn */
  const l2 = ["👥 <b>Báo cáo đơn thủ công theo nhân viên</b>", "🗓 Ngày " + key.slice(3) + "/" + mm + "/2026"];
  if (mau) l2.splice(1, 0, "⚠️ <b>TIN THỬ — số minh hoạ</b>, file nguồn chưa Đăng lên web nên chưa nối số thật");
  if (nguoi.length) {
    l2.push("");
    nguoi.slice(0, 12).forEach(x => {
      const gs = Object.keys(x.o).filter(k => P.clsOf[k] === "Thủ công" && x.o[k]).sort((a, b) => x.o[b] - x.o[a]);
      l2.push(" • " + x.n + ": <b>" + fmt(x.v) + "</b>" + (gs.length > 1 ? " (" + gs.map(k => short(k) + " " + fmt(x.o[k])).join(" · ") + ")" : " · " + short(gs[0])));
    });
    if (nguoi.length > 12) l2.push(" … và " + (nguoi.length - 12) + " người khác");
  } else l2.push("", "Hôm nay chưa có đơn thủ công nào.");
  const tool = listOf("Tự động");
  if (tool.length) {
    const nhieuLoai = new Set(tool.map(x => Object.keys(x.o).filter(k => P.clsOf[k] === "Tự động" && x.o[k])[0])).size > 1;
    lines.push("", "🤖 <b>Tự động theo tool</b>");
    tool.slice(0, 12).forEach(x => {
      const gs = Object.keys(x.o).filter(k => P.clsOf[k] === "Tự động" && x.o[k]).sort((a, b) => x.o[b] - x.o[a]);
      lines.push(" • " + x.n + ": <b>" + fmt(x.v) + "</b>" + (nhieuLoai && gs.length ? " · " + short(gs[0]) : ""));
    });
    if (tool.length > 12) lines.push(" … và " + (tool.length - 12) + " tool khác");
  }
  /* lũy kế tháng */
  const cum = {}, emp = {};
  days.forEach(k => {
    Object.keys(P.byDayLoai[k] || {}).forEach(g => cum[g] = (cum[g] || 0) + P.byDayLoai[k][g]);
    const d = P.byDayNameLoai[k] || {};
    Object.keys(d).forEach(n => Object.keys(d[n]).forEach(g => { if (P.clsOf[g] === "Thủ công") emp[n] = (emp[n] || 0) + d[n][g]; }));
  });
  const cTot = days.reduce((a, k) => a + P.byDay[k], 0);
  const cTC = sumCls(cum, "Thủ công"), cTD = sumCls(cum, "Tự động");
  lines.push("", "📈 <b>Lũy kế tháng " + (+mm) + ": " + fmt(cTot) + " đơn</b> · BQ " + fmt(cTot / (days.length || 1)) + " đơn/ngày");
  lines.push(" 🖐 Thủ công: " + fmt(cTC) + (cTot ? " (" + pct(cTC / cTot) + ")" : ""));
  lines.push.apply(lines, sub(cum, "Thủ công"));
  lines.push(" 🤖 Tự động: " + fmt(cTD) + (cTot ? " (" + pct(cTD / cTot) + ")" : ""));
  lines.push.apply(lines, sub(cum, "Tự động"));
  const top = Object.keys(emp).sort((a, b) => emp[b] - emp[a]);
  if (top.length) {
    l2.push("", "🏅 <b>Top nhân sự tháng " + (+mm) + " (đơn thủ công)</b>");
    top.slice(0, 5).forEach((e, i) => l2.push(" " + ["🥇", "🥈", "🥉", "4.", "5."][i] + " " + e + ": " + fmt(emp[e]) + (cTC ? " (" + pct(emp[e] / cTC) + ")" : "")));
  }
  const dom = process.env.DASH_URL || (process.env.VERCEL_PROJECT_PRODUCTION_URL ? "https://" + process.env.VERCEL_PROJECT_PRODUCTION_URL : "");
  if (dom) l2.push("", "🔗 Chi tiết: " + dom);
  /* biểu đồ 1 — cả tháng theo ngày, cột chồng theo PHÂN LOẠI đơn */
  const charts = [];
  const gAll = P.loaiOrder.slice().sort((a, b) => (cum[b] || 0) - (cum[a] || 0)).filter(g => cum[g]);
  if (days.length && gAll.length) charts.push({
    type: "bar",
    data: {
      labels: days.map(k => k.slice(3) + "/" + k.slice(0, 2)),
      datasets: gAll.map((g, i) => ({ label: g, data: days.map(k => (P.byDayLoai[k] || {})[g] || 0), backgroundColor: PAL[i % PAL.length] }))
    },
    options: {
      title: { display: true, text: "Đơn theo ngày × phân loại — tháng " + (+mm) + "/2026 · tổng " + fmt(cTot), fontSize: 16 },
      legend: { position: "bottom", labels: { boxWidth: 12, fontSize: 11 } },
      scales: { xAxes: [{ stacked: true, ticks: { fontSize: 10 } }], yAxes: [{ stacked: true, ticks: { beginAtZero: true } }] }
    }
  });
  /* biểu đồ 2 — trong ngày: CHỈ nhân viên (khối đơn thủ công, cột J:V trên sheet).
     Tool tự động không phải người nên không đứng chung bảng xếp hạng/biểu đồ nhân sự. */
  const gTC = gAll.filter(g => P.clsOf[g] === "Thủ công");
  if (nguoi.length && gTC.length) charts.push({
    type: "bar",
    data: {
      labels: nguoi.map(x => x.n),
      datasets: gTC.map((g, i) => ({ label: short(g), data: nguoi.map(x => (dNL[x.n] || {})[g] || 0), backgroundColor: PAL[i % PAL.length] }))
    },
    options: {
      title: { display: true, text: "Ngày " + key.slice(3) + "/" + mm + " — năng suất theo nhân viên · " + fmt(tc) + " đơn thủ công", fontSize: 16 },
      legend: { position: "bottom", labels: { boxWidth: 12, fontSize: 11 } },
      scales: {
        xAxes: [{ stacked: true, ticks: { fontSize: 10, minRotation: 45, maxRotation: 60 } }],
        yAxes: [{ stacked: true, ticks: { beginAtZero: true } }]
      }
    }
  });
  return { parts: [{ text: lines.join("\n"), charts: charts.slice(0, 1) },
                   { text: l2.join("\n"), charts: charts.slice(1) }] };
}

/* ---- báo cáo NHẬP HÀNG theo ngày — tab "Data Chi tiết" (gid 14100067) ----
   Khuôn tab: hàng băng "Nhập USDT" / "Nhập VNĐ" → hàng tên nguồn → hàng "Ngày" (ô tổng cột) → mỗi ngày một dòng.
   Giữ nguyên nguyên tệ của từng nhóm như trên sheet; tổng chung quy VNĐ theo tỷ giá TẠM TÍNH FX_USDT. */
const GID_NHAP = (process.env.NHAP_GID || "14100067").trim();
const FILE_NHAP = (process.env.NHAP_PUB_KEY || FILES_ALL.def).trim();
const FX_USDT = +(process.env.FX_USDT || 27000) || 27000;  /* chỉ dùng khi KHÔNG đọc được bảng tỷ giá tuần */
/* ---- bảng TỶ GIÁ THEO TUẦN (file "HQS - BẢNG TỶ GIÁ HÀNG TUẦN") ----
   Khuôn: một hàng ghi NGÀY (d/m, mỗi cột một ngày), hàng "USDT/VND · CO Rate" ghi tỷ giá
   của cả tuần trong ô gộp → kéo giá trị sang phải cho 7 ngày của tuần đó.
   Giá nhập hàng quy VNĐ dùng đúng hàng CO Rate này. */
const GID_FX = (process.env.FX_GID || "1739295342").trim();
const FILE_FX = (process.env.FX_PUB_KEY || FILES_ALL.fx).trim();
function parseFXWeek(rows) {
  if (!rows || rows.length < 5) return null;
  const isD = v => /^\d{1,2}\/\d{1,2}$/.test(nrm(v));
  let dr = -1, best = 0;                       /* hàng NGÀY = hàng có nhiều ô dạng d/m nhất */
  for (let r = 0; r < Math.min(rows.length, 25); r++) {
    const n = (rows[r] || []).filter(isD).length;
    if (n > best) { best = n; dr = r; }
  }
  if (dr < 0 || best < 5) return null;
  let rr = -1;                                 /* hàng CO Rate (nhãn nằm ở mấy cột đầu) */
  for (let r = 0; r < rows.length && rr < 0; r++) {
    const lab = (rows[r] || []).slice(0, 8).map(v => stripD(nrm(v))).join(" ");
    if (/co\s*rate/.test(lab)) rr = r;
  }
  if (rr < 0) return null;
  const row = rows[rr] || [], dates = rows[dr] || [], map = {};
  let cur = 0, n = 0;
  for (let c = 0; c < Math.max(row.length, dates.length); c++) {
    const v = vnum(row[c]); if (v > 1000) cur = v;   /* ô gộp: giá trị nằm ở cột đầu của tuần */
    const m = nrm(dates[c]).match(/^(\d{1,2})\/(\d{1,2})$/);
    if (m && cur) { map[pad2(+m[2]) + "-" + pad2(+m[1])] = cur; n++; }
  }
  return n ? { map, dbg: { dr, rr, nNgay: n } } : null;
}
let FXW_CACHE;
async function fxWeek() {
  if (FXW_CACHE !== undefined) return FXW_CACHE;
  const rows = await readTab(GID_FX, FILE_FX);
  FXW_CACHE = (rows ? parseFXWeek(rows) : null) || null;
  return FXW_CACHE;
}
function parseNhap(rows) {
  if (!rows || rows.length < 6) return null;
  let gr = -1;   /* hàng băng = hàng có ô "Nhập USDT" */
  for (let r = 0; r < Math.min(rows.length, 25) && gr < 0; r++)
    if ((rows[r] || []).some(v => /nhap\s*usdt/.test(stripD(nrm(v))))) gr = r;
  if (gr < 0) return null;
  const band = []; let cur = "";   /* băng là ô gộp → kéo tên băng sang các cột bên phải */
  (rows[gr] || []).forEach((v, i) => { const t = nrm(v); if (t) cur = t; band[i] = cur; });
  const names = rows[gr + 1] || [], src = [];
  for (let c = 1; c < names.length; c++) {
    const n = nrm(names[c]); if (!n) continue;
    const g = nrm(band[c]) || "Nhập VNĐ";
    src.push({ c, name: n, grp: g, usd: /usdt/.test(stripD(g)), daily: {} });
  }
  if (!src.length) return null;
  const days = {};
  for (let r = gr + 2; r < rows.length; r++) {
    const row = rows[r] || [];
    const m = nrm(row[0]).match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})/);   /* ngày ghi kiểu d/m/yyyy */
    if (!m) continue;                                                /* hàng "Ngày" (dòng tổng) tự bị bỏ qua */
    const k = pad2(+m[2]) + "-" + pad2(+m[1]);
    days[k] = 1;
    src.forEach(s => { const v = vnum(row[s.c]); if (v) s.daily[k] = (s.daily[k] || 0) + v; });
  }
  const ds = Object.keys(days).sort();
  if (!ds.length) return null;
  return { src: src.filter(s => Object.keys(s.daily).length), days: ds, fx: FX_USDT };
}
async function buildNhap(q) {
  const rows = await readTab(GID_NHAP, FILE_NHAP);
  const P = rows ? parseNhap(rows) : null;
  if (!P) return { skip: "khong_doc_duoc_tab_Data_Chi_tiet_kiem_tra_publish_to_web" };
  /* tỷ giá CO theo TUẦN; ngày nào bảng tỷ giá chưa có thì lấy tỷ giá tuần gần nhất trước đó */
  const FX = await fxWeek();
  const FXK = FX ? Object.keys(FX.map).sort() : [];
  const rate = k => {
    if (!FXK.length) return FX_USDT;
    if (FX.map[k]) return FX.map[k];
    const past = FXK.filter(x => x <= k);
    return past.length ? FX.map[past[past.length - 1]] : FX.map[FXK[0]];
  };
  const vnd = (s, k) => (s.daily[k] || 0) * (s.usd ? rate(k) : 1);
  const tongVND = k => P.src.reduce((a, s) => a + vnd(s, k), 0);
  let key = reportDay(q).key;
  const avail = P.days.filter(k => tongVND(k) > 0);
  if (!avail.length) return { skip: "tab_Data_Chi_tiet_chua_co_so" };
  if (avail.indexOf(key) < 0) { const past = avail.filter(k => k <= key); key = past.length ? past[past.length - 1] : avail[avail.length - 1]; }
  const mm = key.slice(0, 2), days = avail.filter(k => k.slice(0, 2) === mm && k <= key);
  const fu = n => n ? n.toLocaleString("vi-VN", { maximumFractionDigits: 2 }) : "0";
  const sumK = (s, ks) => ks.reduce((a, k) => a + (s.daily[k] || 0), 0);
  const tenNg = n => n.replace(/^data\s+/i, "");   /* "Data Giftcard" trên sheet → gọi gọn "Giftcard" */
  /* ----- trong ngày ----- */
  const dU = P.src.filter(s => s.usd).map(s => ({ n: s.name, v: s.daily[key] || 0 })).filter(x => x.v).sort((a, b) => b.v - a.v);
  const dV = P.src.filter(s => !s.usd).map(s => ({ n: s.name, v: s.daily[key] || 0 })).filter(x => x.v).sort((a, b) => b.v - a.v);
  const rK = rate(key);
  const sU = dU.reduce((a, x) => a + x.v, 0), sV = dV.reduce((a, x) => a + x.v, 0), sT = sU * rK + sV;
  const lines = ["💵 <b>Nhập hàng theo ngày — Phòng vận hành</b>", "🗓 Ngày " + key.slice(3) + "/" + mm + "/2026"];
  lines.push("", "🧮 <b>Tổng nhập quy VNĐ: " + fmt(sT) + " đ</b>");
  lines.push("💵 <b>Nhập USDT: " + fu(sU) + "</b>" + (sU ? " ≈ " + fmt(sU * rK) + " đ (" + pct(sU * rK / sT) + ")" : ""));
  lines.push(dU.length ? " • " + dU.map(x => tenNg(x.n) + ": " + fu(x.v)).join(" · ") : " • chưa có số");
  lines.push("🏦 <b>Nhập VNĐ: " + fmt(sV) + " đ</b>" + (sV && sT ? " (" + pct(sV / sT) + ")" : ""));
  lines.push(dV.length ? " • " + dV.map(x => tenNg(x.n) + ": " + fmt(x.v) + " đ").join(" · ") : " • chưa có số");
  lines.push("Tỷ giá : " + fmt(rK) + " đ/USDT" + (FXK.length ? "" : " ⚠ tạm tính, chưa đọc được bảng tỷ giá tuần"));
  /* ----- lũy kế tháng ----- */
  const cU = P.src.filter(s => s.usd).reduce((a, s) => a + sumK(s, days), 0);
  const cV = P.src.filter(s => !s.usd).reduce((a, s) => a + sumK(s, days), 0);
  /* mỗi ngày quy theo tỷ giá của TUẦN ngày đó, không nhân cả tháng bằng một tỷ giá */
  const cUv = days.reduce((a, k) => a + P.src.filter(s => s.usd).reduce((x, s) => x + (s.daily[k] || 0), 0) * rate(k), 0);
  const cT = cUv + cV;
  lines.push("", "📈 <b>Lũy kế tháng " + (+mm) + ": " + fmt(cT) + " đ</b> · BQ " + fmt(cT / (days.length || 1)) + " đ/ngày");
  /* lũy kế giữ NGUYÊN TỆ: USDT ghi bằng USDT, VNĐ ghi bằng đồng — % là tỷ trọng trong tổng quy VNĐ */
  lines.push(" 💵 USDT " + fu(cU) + (cT ? " (" + pct(cUv / cT) + ")" : "") +
             " · 🏦 VNĐ " + fmt(cV) + " đ" + (cT ? " (" + pct(cV / cT) + ")" : ""));
  /* top nguồn trong tháng, quy về VNĐ để xếp chung một thước đo */
  const topNg = P.src.map(s => ({ n: s.name, usd: s.usd, raw: sumK(s, days),
      v: days.reduce((a, k) => a + (s.daily[k] || 0) * (s.usd ? rate(k) : 1), 0) }))
    .filter(x => x.v).sort((a, b) => b.v - a.v);
  if (topNg.length) {
    const HUY = ["🥇", "🥈", "🥉", "4.", "5."];
    let daGhiUSDT = false;   /* đơn vị USDT chỉ ghi ở nguồn USDT đầu tiên cho gọn */
    lines.push("", "🏅 <b>Nguồn nhập nhiều nhất tháng " + (+mm) + "</b>");
    lines.push(" " + topNg.slice(0, 5).map((x, i) => {
      const so = x.usd ? fu(x.raw) + (daGhiUSDT ? "" : " USDT") : fmt(x.v) + " đ";
      if (x.usd) daGhiUSDT = true;
      return HUY[i] + " " + tenNg(x.n) + " " + so;
    }).join(" · "));
  }
  /* biểu đồ 1 — cả tháng theo ngày, cột chồng: USDT quy đổi + VNĐ */
  const charts = [];
  const dayU = k => P.src.filter(s => s.usd).reduce((a, s) => a + (s.daily[k] || 0), 0) * rate(k);
  const dayV = k => P.src.filter(s => !s.usd).reduce((a, s) => a + (s.daily[k] || 0), 0);
  if (days.length) charts.push({
    type: "bar",
    data: {
      labels: days.map(k => k.slice(3) + "/" + k.slice(0, 2)),
      datasets: [
        { label: "Nhập USDT (quy VNĐ)", data: days.map(dayU), backgroundColor: PAL[0] },
        { label: "Nhập VNĐ", data: days.map(dayV), backgroundColor: PAL[2] }
      ]
    },
    options: {
      title: { display: true, text: "Nhập theo ngày — tháng " + (+mm) + "/2026 · tổng " + fmt(cT) + " đ", fontSize: 16 },
      legend: { position: "bottom", labels: { boxWidth: 12, fontSize: 11 } },
      scales: { xAxes: [{ stacked: true, ticks: { fontSize: 10 } }], yAxes: [{ stacked: true, ticks: { beginAtZero: true } }] }
    }
  });
  return { text: lines.join("\n"), charts };
}
/* ---- báo cáo năng suất nhân viên: 2 biểu đồ ---- */
async function buildNS(q) {
  /* Từ T10/2026 số nằm ở file mới (tab "BC đơn") và chia theo PHÂN LOẠI đơn.
     Tháng 10 trở đi CHỈ dùng nguồn mới — chưa nối được thì im lặng, KHÔNG quay về form cũ
     (tab cũ đã ngừng cập nhật, bắn ra sẽ sai số). Form cũ chỉ còn dùng cho ngày TRƯỚC 01/10. */
  const RDm = +reportDay(q).key.slice(0, 2);
  if (q.mau === "1" || RDm >= 10) return await buildBC(q);
  const rows = await readTab(GIDS.ns);
  let key = reportDay(q).key;
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

const REPORTS = { pvh10: buildPVH10, nv: buildNS, nhap: buildNhap };
/* PVH10 (form cũ — đơn thủ công theo game) TẮT từ 02/10/2026: nguồn cũ không còn được cập nhật
   (01/10 chỉ đọc 17 đơn trong khi tab BC đơn ghi gần 600) và tin mới đã có đủ phân loại đơn.
   Bật lại khi cần: đặt biến môi trường TELE_PVH10=1 trên Vercel, không phải sửa code. */
const REPORTS_OFF = process.env.TELE_PVH10 === "1" ? {} : { pvh10: 1 };
/* Báo cáo nào gửi vào box nào: mặc định gửi MỌI box đã khai (PVH và PCU).
   Muốn giới hạn riêng một báo cáo thì khai TELE_BOXES_<TÊN>="chatid:topicid,…"
   (ví dụ TELE_BOXES_NV để báo cáo năng suất nhân viên chỉ vào một box). */
/* Riêng báo cáo NHẬP HÀNG (có số tiền nhập) mặc định chỉ vào BOX ĐẦU (PVH) cho kín;
   muốn gửi thêm box khác thì khai TELE_BOXES_NHAP="chatid:topicid,chatid:topicid". */
const BOX_1 = { nhap: 1 };
function boxesFor(r) {
  const E = (process.env["TELE_BOXES_" + r.toUpperCase()] || "").trim();
  if (E) return parseBoxes(E);
  const T = targets();
  return BOX_1[r] ? T.slice(0, 1) : T;
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
        /* tìm dòng chứa một từ khoá: &tim=<chữ> — xem nguyên dòng đó trên tab (vd dòng Supercell
           trong tab tổng theo tháng) để biết tháng nào đang có số, tháng nào trống */
        if (!html && rows.length > 1 && q.tim) {
          const need = stripD(q.tim); let hit = 0;
          for (let r = 0; r < rows.length && hit < 6; r++) {
            const row = rows[r] || [];
            if (!row.slice(0, 6).some(v => stripD(nrm(v)).indexOf(need) > -1)) continue;
            hit++;
            rp.push("   [dong " + r + "] " + row.map((v, i) => i + ":" + nrm(v)).filter(x => x.split(":").slice(1).join(":")).slice(0, 30).join("  "));
          }
          if (!hit) rp.push("   KHONG thay dong nao chua '" + q.tim + "'");
        }
        /* &xem=<n>: in nguyên n dòng đầu (kèm số thứ tự cột) — xem khuôn của một tab mới */
        if (!html && rows.length && q.xem) {
          const n = Math.min(+String(q.xem).replace(/\D/g, "") || 12, 40);
          rp.push("   " + n + " DONG DAU CO CHU (cot:gia tri)");
          let shown = 0;
          for (let r = 0; r < rows.length && shown < n; r++) {
            const cells = (rows[r] || []).map((v, i) => i + ":" + nrm(v)).filter(x => x.slice(x.indexOf(":") + 1));
            if (!cells.length) continue;
            shown++;
            rp.push("   [dong " + r + "] " + cells.slice(0, 45).join("  ").slice(0, 1500));
          }
        }
        /* cộng số theo tháng: &ngay=<cột ngày>&gia=<cột tiền>[&loc=<cột>:<chữ cần chứa, bỏ dấu>]
           dùng để đối chiếu một tab RAW (vd Data Supercell) với số đang hiện trên trang */
        if (!html && rows.length > 1 && q.ngay != null && q.gia != null) {
          const ci = +q.ngay, vi = +q.gia, lc = q.loc ? String(q.loc).split(":") : null;
          const per = {}; let n = 0, bỏ = 0, noDate = 0;
          for (const row of rows) {
            const dv = nrm((row || [])[ci]);
            const m = dv.match(/^(\d{1,2})\/(\d{1,2})(?:\/(\d{2,4}))?/);
            if (!m) { noDate++; continue; }
            if (lc && stripD(nrm((row || [])[+lc[0]])).indexOf(stripD(lc[1] || "")) < 0) { bỏ++; continue; }
            const k = (m[3] ? ("20" + m[3].slice(-2)) : "????") + "-" + pad2(+m[2]);
            const p = (per[k] = per[k] || { n: 0, s: 0 }); p.n++; p.s += vnum((row || [])[vi]); n++;
          }
          rp.push("   CONG THEO THANG (cot ngay=" + ci + ", cot tien=" + vi + (lc ? ", loc cot " + lc[0] + " chua '" + lc[1] + "'" : "") + ")");
          Object.keys(per).sort().forEach(k => rp.push("     " + k + ": " + per[k].n + " dong · " + per[k].s.toLocaleString("vi-VN", { maximumFractionDigits: 2 })));
          rp.push("     => " + n + " dong tinh vao · " + bỏ + " dong bi bo loc loai · " + noDate + " dong khong co ngay o cot " + ci);
          /* &ngayle=<mm>: cộng theo TỪNG NGÀY của tháng đó — để đối chiếu số tuần trên trang */
          if (q.ngayle) {
            const mm = pad2(+String(q.ngayle).replace(/\D/g, "") || 0);
            const pd = {};
            for (const row of rows) {
              const dv = nrm((row || [])[ci]);
              const m = dv.match(/^(\d{1,2})\/(\d{1,2})(?:\/(\d{2,4}))?/); if (!m) continue;
              if (pad2(+m[2]) !== mm) continue;
              if (lc && stripD(nrm((row || [])[+lc[0]])).indexOf(stripD(lc[1] || "")) < 0) continue;
              const k = pad2(+m[1]);
              const p = (pd[k] = pd[k] || { n: 0, s: 0 }); p.n++; p.s += vnum((row || [])[vi]);
            }
            rp.push("   CONG THEO NGAY thang " + mm);
            Object.keys(pd).sort().forEach(k => rp.push("     " + k + "/" + mm + ": " + pd[k].n + " dong · " + pd[k].s.toLocaleString("vi-VN", { maximumFractionDigits: 2 })));
            if (!Object.keys(pd).length) rp.push("     (khong co dong nao trong thang " + mm + ")");
          }
        }
      } catch (e) { rp.push("[" + f + "] loi: " + (e && e.message ? e.message : e)); }
    }
    res.setHeader("Content-Type", "text/plain; charset=utf-8"); res.setHeader("Cache-Control", "no-store");
    res.status(200).send("SOI TAB gid=" + gid + "\n\n" + rp.join("\n")); return;
  }
  /* ?tygia=1 — soi bảng tỷ giá tuần: đọc ra bao nhiêu ngày, tỷ giá CO của các ngày gần đây */
  if (q.tygia) {
    const rws = await readTab(GID_FX, FILE_FX);
    const F = rws ? parseFXWeek(rws) : null;
    const rp = ["SOI BANG TY GIA TUAN gid=" + GID_FX, "so dong doc duoc: " + (rws ? rws.length : "KHONG DOC DUOC")];
    if (F) {
      rp.push("hang NGAY = dong " + F.dbg.dr + " · hang CO Rate = dong " + F.dbg.rr + " · " + F.dbg.nNgay + " ngay co ty gia");
      const ks = Object.keys(F.map).sort();
      rp.push("20 ngay gan nhat:");
      ks.slice(-20).forEach(k => rp.push("   " + k.slice(3) + "/" + k.slice(0, 2) + ": " + fmt(F.map[k])));
    } else if (rws) {
      rp.push("KHONG nhan ra khuon — 12 dong dau:");
      for (let r = 0; r < Math.min(rws.length, 12); r++)
        rp.push(" [dong " + r + "] " + (rws[r] || []).map((v, i) => i + ":" + nrm(v)).filter(x => x.slice(x.indexOf(":") + 1)).slice(0, 30).join("  ").slice(0, 900));
    }
    res.setHeader("Content-Type", "text/plain; charset=utf-8"); res.setHeader("Cache-Control", "no-store");
    res.status(200).send(rp.join("\n")); return;
  }
  /* r có thể liệt kê nhiều báo cáo: ?r=nv,nhap — mặc định lấy env TELE_REPORTS */
  const rs = ("" + (q.r || process.env.TELE_REPORTS || "nv,nhap")).toLowerCase().split(/[,;\s]+/).filter((x, i, a) => x && a.indexOf(x) === i);
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
  const done = [], preview = [];
  for (const r of rs) {
    if (REPORTS_OFF[r]) { done.push({ report: r, skip: "bao_cao_da_tat" }); if (q.dry) preview.push("=== " + r + " === (đã tắt)"); continue; }
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
    /* một báo cáo có thể gồm NHIỀU TIN (vd: tin phân loại đơn + tin năng suất nhân viên) */
    const parts = (out && out.parts) ? out.parts : [{
      text: typeof out === "string" ? out : out.text,
      charts: (typeof out === "object" && (out.charts || (out.chart ? [out.chart] : []))) || []
    }];
    if (q.dry) {
      preview.push(parts.map((p, i) => "=== " + r + (parts.length > 1 ? " · tin " + (i + 1) : "") + " ===\n" + p.text +
        (p.charts.length ? "\n\n[kèm " + p.charts.length + " biểu đồ: " + p.charts.map(c => c.data.labels.length + "×" + c.data.datasets.length).join(", ") + "]" : "")).join("\n\n"));
      continue;
    }
    try {
      /* render ảnh 1 lần cho từng tin, dùng chung cho mọi box */
      const imgsOf = await Promise.all(parts.map(p => q.noimg === "1" ? Promise.resolve([]) : Promise.all(p.charts.map(chartURL))));
      /* ?box=<chatid>[:<topic>] — bắn thử vào đúng một box/topic, chỉ cho lần gọi này.
         Lấy từ link Telegram t.me/c/<chatid>/<topic> → box=-100<chatid>:<topic>.
         tin thử (?mau=1) chỉ gửi BOX ĐẦU để không làm nhiễu các box khác */
      const sent = [], boxes = q.box ? parseBoxes(String(q.box))
        : (q.mau === "1" ? boxesFor(r).slice(0, 1) : boxesFor(r));
      let nAnh = 0;
      for (const b of boxes) {
        let okBox = true, photoBox = false, err;
        for (let pi = 0; pi < parts.length; pi++) {
          const text = parts[pi].text, imgs = (imgsOf[pi] || []).filter(Boolean);
          if (!b.__dem) nAnh += imgs.length;
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
          if (!(j && j.ok)) { okBox = false; err = j && j.description; }
          if (photo) photoBox = true;
        }
        b.__dem = 1;
        sent.push({ chat: b.chat, ok: okBox, photo: photoBox, error: okBox ? undefined : err });
      }
      const anyOk = sent.some(x => x.ok);
      if (!anyOk && markKey) await kv(["DEL", markKey]); /* không box nào nhận được thì nhả khung để lần gõ cửa sau thử lại */
      done.push({ report: r, ok: anyOk, tin: parts.length, anh: nAnh, boxes: sent });
    } catch (e) {
      if (markKey) await kv(["DEL", markKey]);
      done.push({ report: r, ok: false, error: "" + (e && e.message ? e.message : e) });
    }
  }
  if (q.dry) { res.setHeader("Content-Type", "text/plain; charset=utf-8"); res.status(200).send(preview.join("\n\n")); return; }
  res.status(200).json({ ok: done.some(x => x.ok), ket_qua: done });
};
