// Trang tự kiểm tra & cài đặt bot — mở bằng trình duyệt:
//   https://<domain>/api/setup?key=<TASKBOT_SECRET>
// Tự dò biến môi trường còn thiếu, thử Telegram / Apps Script / KV,
// soi bảng nhân sự tìm lỗi, và nối webhook giúp (?act=hook).
const L = require("./_lib");

const esc = s => String(s == null ? "" : s)
  .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/* Che bớt giá trị nhạy cảm khi hiện ra màn hình */
function che(v) {
  if (!v) return "";
  const s = String(v);
  return s.length <= 8 ? "••••" : s.slice(0, 4) + "••••" + s.slice(-4);
}

const BIEN = [
  ["TASKBOT_TOKEN", true, "Token BotFather cấp cho bot"],
  ["TASKBOT_USERNAME", true, "Tên bot, không có @ — vd trolyquynhhtn"],
  ["TASKBOT_SECRET", true, "Chuỗi tự đặt, dùng cho webhook và /api/remind"],
  ["GS_WEBAPP_URL", true, "URL /exec của Apps Script"],
  ["GS_SECRET", true, "Đúng chuỗi SECRET trong Code.gs"],
  ["TG_VH", false, "Chat ID box Vận hành"],
  ["TG_HR", false, "Chat ID box HR"],
  ["TG_KT", false, "Chat ID box Kế toán"],
  ["BOSS_TG_ID", false, "Telegram ID của sếp — nhận báo cáo sáng"],
  ["KV_REST_API_URL", true, "Có sẵn từ Upstash/Vercel KV"],
  ["KV_REST_API_TOKEN", true, "Có sẵn từ Upstash/Vercel KV"]
];

/* ---- soi bảng nhân sự tìm lỗi sẽ làm bot đọc sai ---- */
function soiNhanSu(roster) {
  const loi = [], canh = [];
  if (!roster.length) { loi.push("Chưa đọc được người nào từ tab nhân sự."); return { loi, canh }; }

  const dungBiDanh = new Map();
  for (const nv of roster) {
    if (!nv.phong) loi.push("<b>" + esc(nv.ma) + "</b> chưa có <code>phong</code> — bot không biết bắn vào box nào.");
    else if (!["VH", "HR", "KT"].includes(nv.phong))
      canh.push("<b>" + esc(nv.ma) + "</b> có phong = <code>" + esc(nv.phong) + "</code>, chưa khai box tương ứng.");
    if (!nv.vai_tro) canh.push("<b>" + esc(nv.ma) + "</b> chưa có <code>vai_tro</code> (leader/nhanvien).");
    if (!nv.tele) canh.push("<b>" + esc(nv.ma) + "</b> chưa có Telegram.");
    if (!nv.tg_id) canh.push("<b>" + esc(nv.ma) + "</b> chưa <code>/start</code> — bot chưa nhắn riêng được.");

    const ds = [nv.ma].concat(String(nv.bi_danh || "").split(","))
      .map(x => L.bothDau(String(x || "").trim())).filter(x => x.length >= 2);
    if (ds.length <= 1) canh.push("<b>" + esc(nv.ma) + "</b> chưa có <code>bi_danh</code> — chỉ nhận ra khi gõ đúng tên trên sheet.");
    for (const bd of ds) {
      if (dungBiDanh.has(bd) && dungBiDanh.get(bd) !== nv.ma)
        loi.push("Bí danh <code>" + esc(bd) + "</code> trùng giữa <b>" + esc(dungBiDanh.get(bd)) + "</b> và <b>" + esc(nv.ma) + "</b> — bot sẽ đoán sai người.");
      else dungBiDanh.set(bd, nv.ma);
    }
  }
  for (const ph of ["VH", "HR", "KT"]) {
    const co = roster.filter(x => x.phong === ph);
    if (co.length && !co.some(x => x.vai_tro === "leader"))
      canh.push("Phòng <b>" + ph + "</b> chưa có ai là <code>leader</code> — việc trễ sẽ báo thẳng cho sếp.");
  }
  return { loi, canh };
}

module.exports = async (req, res) => {
  const q = req.query || {};
  const S = process.env.TASKBOT_SECRET || "";
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.setHeader("Cache-Control", "no-store");

  if (!S) {
    res.status(200).send(trang("<div class=box err><h2>Chưa đặt TASKBOT_SECRET</h2>" +
      "<p>Vào Vercel → Settings → Environment Variables, thêm <code>TASKBOT_SECRET</code> " +
      "(chuỗi bất kỳ do bạn tự đặt), bấm Redeploy rồi mở lại trang này kèm <code>?key=&lt;chuỗi đó&gt;</code>.</p></div>"));
    return;
  }
  if (q.key !== S) { res.status(401).send(trang("<div class=box err><h2>Sai key</h2><p>Thêm <code>?key=&lt;TASKBOT_SECRET&gt;</code> vào cuối địa chỉ.</p></div>")); return; }

  const dom = process.env.DASH_URL ||
    (process.env.VERCEL_PROJECT_PRODUCTION_URL ? "https://" + process.env.VERCEL_PROJECT_PRODUCTION_URL : "");
  const hookUrl = dom ? dom + "/api/bot" : "";
  const H = [];

  /* --- hành động --- */
  let thongBao = "";
  if (q.act === "hook" && hookUrl) {
    const r = await L.tg("setWebhook", { url: hookUrl, secret_token: S, allowed_updates: ["message", "callback_query"] });
    thongBao = r.ok ? "<div class=box ok><b>Đã nối webhook</b> tới <code>" + esc(hookUrl) + "</code></div>"
      : "<div class=box err><b>Nối webhook hỏng:</b> " + esc(r.description || "") + "</div>";
  }
  if (q.act === "unhook") {
    const r = await L.tg("deleteWebhook", {});
    thongBao = "<div class=box warn><b>Đã gỡ webhook.</b> " + esc(r.description || "") + "</div>";
  }
  if (q.act === "reload") { await L.kv(["DEL", "task:roster"]); thongBao = "<div class=box ok><b>Đã xoá cache bảng nhân sự</b> — lần đọc sau lấy bản mới nhất.</div>"; }

  /* --- 1. biến môi trường --- */
  let thieuBatBuoc = 0;
  const rowsBien = BIEN.map(([ten, batbuoc, mo]) => {
    const v = process.env[ten];
    if (!v && batbuoc) thieuBatBuoc++;
    const tt = v ? "<span class=y>✓</span>" : (batbuoc ? "<span class=n>✗ thiếu</span>" : "<span class=w>— chưa đặt</span>");
    return "<tr><td><code>" + ten + "</code></td><td>" + tt + "</td><td class=dim>" +
      (v ? esc(che(v)) : esc(mo)) + "</td></tr>";
  }).join("");

  /* --- 2. Telegram --- */
  const me = await L.tg("getMe", {});
  const wh = await L.tg("getWebhookInfo", {});
  const whUrl = (wh.result && wh.result.url) || "";
  const whOk = hookUrl && whUrl === hookUrl;

  /* --- 3. Apps Script + bảng nhân sự --- */
  const ping = await L.gs("ping");
  const roster = await L.layNhanSu(true);
  const cl = await L.docChecklist();
  const { loi, canh } = soiNhanSu(roster);
  const clBat = cl.filter(c => L.BAT(c.bat));

  /* --- 4. KV --- */
  await L.kv(["SET", "task:selftest", String(Date.now()), "EX", "60"]);
  const kvOk = !!(await L.kv(["GET", "task:selftest"]));

  /* --- kết luận --- */
  const sanSang = !thieuBatBuoc && me.ok && whOk && ping.ok && roster.length && kvOk && !loi.length;

  H.push(thongBao);
  H.push("<div class='box " + (sanSang ? "ok" : "warn") + "'><h2>" +
    (sanSang ? "✅ Sẵn sàng — vào box tag bot và giao việc được rồi" : "⏳ Còn thiếu vài thứ, xem bên dưới") +
    "</h2></div>");

  H.push("<h3>1 · Biến môi trường</h3><table>" + rowsBien + "</table>");

  H.push("<h3>2 · Telegram</h3><table>" +
    "<tr><td>Bot</td><td>" + (me.ok ? "<span class=y>✓</span> @" + esc(me.result.username) : "<span class=n>✗ " + esc(me.description || "") + "</span>") + "</td></tr>" +
    "<tr><td>Webhook</td><td>" + (whOk ? "<span class=y>✓</span> đã nối" :
      (whUrl ? "<span class=w>đang trỏ tới " + esc(whUrl) + "</span>" : "<span class=n>✗ chưa nối</span>")) + "</td></tr>" +
    (wh.result && wh.result.last_error_message ?
      "<tr><td>Lỗi gần nhất</td><td class=n>" + esc(wh.result.last_error_message) + "</td></tr>" : "") +
    "<tr><td>Việc đang chờ</td><td class=dim>" + ((wh.result && wh.result.pending_update_count) || 0) + "</td></tr>" +
    "</table>" +
    (hookUrl ? "<p><a class=btn href='?key=" + encodeURIComponent(S) + "&act=hook'>Nối webhook ngay</a> " +
      "<a class='btn ghost' href='?key=" + encodeURIComponent(S) + "&act=unhook'>Gỡ webhook</a></p>"
      : "<p class=n>Chưa xác định được tên miền — đặt biến <code>DASH_URL</code>.</p>"));

  H.push("<h3>3 · Google Sheet</h3><table>" +
    "<tr><td>Apps Script</td><td>" + (ping.ok ? "<span class=y>✓</span> " + esc(ping.sheet || "") :
      "<span class=n>✗ " + esc(ping.error || "không gọi được") + "</span>") + "</td></tr>" +
    "<tr><td>Nhân sự đọc được</td><td>" + (roster.length ? "<span class=y>✓</span> " + roster.length + " người" : "<span class=n>✗ 0</span>") + "</td></tr>" +
    "<tr><td>Checklist đang bật</td><td>" + (clBat.length ? "<span class=y>✓</span> " + clBat.length + "/" + cl.length + " dòng" :
      "<span class=w>0/" + cl.length + " — chưa bật dòng nào</span>") + "</td></tr>" +
    "<tr><td>Kho KV</td><td>" + (kvOk ? "<span class=y>✓</span>" : "<span class=n>✗</span>") + "</td></tr>" +
    "</table><p><a class='btn ghost' href='?key=" + encodeURIComponent(S) + "&act=reload'>Đọc lại bảng nhân sự</a></p>");

  if (loi.length) H.push("<div class='box err'><b>Lỗi phải sửa — bot sẽ đọc sai:</b><ul><li>" + loi.join("</li><li>") + "</li></ul></div>");
  if (canh.length) H.push("<div class='box warn'><b>Nên bổ sung:</b><ul><li>" + canh.join("</li><li>") + "</li></ul></div>");

  if (roster.length) {
    H.push("<h3>4 · Bảng nhân sự bot đang thấy</h3><table><tr><th>Tên</th><th>Telegram</th><th>Phòng</th><th>Vai trò</th><th>Bí danh</th><th>Đã /start</th></tr>" +
      roster.map(nv => "<tr><td><b>" + esc(nv.ma) + "</b></td><td class=dim>" + esc(nv.tele) + "</td><td>" +
        (nv.phong ? esc(nv.phong) : "<span class=n>—</span>") + "</td><td>" +
        (nv.vai_tro ? esc(nv.vai_tro) : "<span class=w>—</span>") + "</td><td class=dim>" +
        (nv.bi_danh ? esc(nv.bi_danh) : "<span class=w>—</span>") + "</td><td>" +
        (nv.tg_id ? "<span class=y>✓</span>" : "<span class=w>chưa</span>") + "</td></tr>").join("") + "</table>");
  }

  H.push("<h3>5 · Thử nhanh</h3><p class=dim>Sau khi mọi thứ xanh, vào box gõ:</p>" +
    "<pre>@" + esc(process.env.TASKBOT_USERNAME || "tenbot") + " " +
    esc(roster[0] ? (String(roster[0].bi_danh || roster[0].ma).split(",")[0].trim()) : "Tên người") +
    " việc thử nghiệm 17h mai</pre>" +
    "<p class=dim>Hoặc chạy bộ nhắc ở chế độ không gửi: <code>/api/remind?key=…&amp;dry=1</code> · " +
    "sinh checklist thử: <code>/api/remind?key=…&amp;sinh=1&amp;dry=1</code></p>");

  res.status(200).send(trang(H.join("\n")));
};

function trang(noi) {
  return `<!doctype html><html lang=vi><head><meta charset=utf-8>
<meta name=viewport content="width=device-width,initial-scale=1">
<title>Cài đặt bot giao việc</title><style>
:root{--bg:#f1f4f9;--card:#fff;--ink:#0d1826;--dim:#5b6b80;--rule:#dce3ec;--navy:#123a6b}
@media(prefers-color-scheme:dark){:root{--bg:#0a1220;--card:#111c2c;--ink:#e6ecf5;--dim:#8ea0b5;--rule:#223247;--navy:#7babe2}}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--ink);font:15px/1.6 ui-sans-serif,system-ui,"Segoe UI",Roboto,sans-serif}
.wrap{max-width:900px;margin:0 auto;padding:28px 18px 80px}
h1{font:700 26px/1.2 Georgia,serif;margin:0 0 4px}
h3{font:700 17px/1.3 Georgia,serif;margin:30px 0 10px;border-bottom:1px solid var(--rule);padding-bottom:6px}
table{width:100%;border-collapse:collapse;background:var(--card);border:1px solid var(--rule);border-radius:4px;overflow:hidden}
td,th{padding:8px 12px;border-bottom:1px solid var(--rule);text-align:left;font-size:14px;vertical-align:top}
th{font-size:11px;text-transform:uppercase;letter-spacing:.1em;color:var(--dim);font-weight:500}
tr:last-child td{border-bottom:0}
code{font-family:ui-monospace,Consolas,monospace;font-size:.88em;background:var(--bg);padding:1px 5px;border-radius:3px}
pre{background:var(--card);border:1px solid var(--rule);border-radius:4px;padding:12px;overflow-x:auto;font-family:ui-monospace,Consolas,monospace;font-size:13px}
.box{border-radius:4px;padding:12px 16px;margin:14px 0;border-left:3px solid var(--navy);background:var(--card)}
.box h2{font:700 17px/1.3 Georgia,serif;margin:0}
.box ul{margin:8px 0 0;padding-left:20px}.box li{margin:3px 0;font-size:14px}
.ok{border-left-color:#1b6e48}.warn{border-left-color:#9a6412}.err{border-left-color:#a5342c}
.y{color:#1b6e48;font-weight:600}.n{color:#a5342c;font-weight:600}.w{color:#9a6412}
@media(prefers-color-scheme:dark){.y{color:#56b98a}.n{color:#e4796f}.w{color:#d9a54a}}
.dim{color:var(--dim)}
.btn{display:inline-block;background:var(--navy);color:var(--bg);text-decoration:none;padding:7px 14px;border-radius:4px;font-size:14px;font-weight:600}
.btn.ghost{background:transparent;color:var(--navy);border:1px solid var(--rule)}
a{color:var(--navy)}
</style></head><body><div class=wrap>
<h1>Cài đặt bot giao việc</h1>
<p class=dim>Trang này chỉ mình bạn mở được (cần <code>key</code>). Sửa xong trên Vercel hoặc Sheet thì tải lại trang.</p>
${noi}
</div></body></html>`;
}
