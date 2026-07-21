// Vercel Serverless Function — Số dư deposit tại các NCC (PVH14)
// Lưu số dư ở Vercel KV (key pvh:nccbal); chỉ admin (verify Google id_token như /api/perm) hoặc secret NCC_SECRET (cho cron) gọi được.
// Actions: get (đọc bảng số dư) · set (nhập tay 1 NCC) · poll (gọi API các NCC có hỗ trợ — hiện: Galaxylink)
const crypto = require("crypto");
const CLIENT_ID = "195227450871-agk96k2h1897lnvgjk7uorfoe2q9dqqi.apps.googleusercontent.com";
const SUPER_ADMIN = "quynhhtn@hqplay.vn";

const KV_URL = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL || "";
const KV_TOKEN = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN || "";

const NCCS = [
  { id: "glx",      name: "Galaxylink",      url: "b2b.galaxylink.gg",   api: true  },
  { id: "rbxcrate", name: "RBXCrate",        url: "rbxcrate.com",        api: false },
  { id: "bsv",      name: "BuySellVouchers", url: "buysellvouchers.com", api: false },
  { id: "lotkeys",  name: "Lotkeys",         url: "lotkeys.com",         api: false },
  { id: "oggx",     name: "OGGamingX",       url: "oggamingx.com",       api: false },
  { id: "donq",     name: "Donquixoteshop",  url: "donquixoteshop.com",  api: false }
];
const BAL_KEY = "pvh:nccbal";

async function kv(cmd) {
  const r = await fetch(KV_URL, {
    method: "POST",
    headers: { Authorization: "Bearer " + KV_TOKEN, "Content-Type": "application/json" },
    body: JSON.stringify(cmd)
  });
  const j = await r.json();
  return j.result;
}
async function getStore() {
  try {
    const raw = await kv(["GET", BAL_KEY]);
    if (!raw) return { balances: {}, glxPath: null };
    const o = typeof raw === "string" ? JSON.parse(raw) : raw;
    return { balances: o.balances || {}, glxPath: o.glxPath || null };
  } catch (e) { return { balances: {}, glxPath: null }; }
}
async function setStore(o) { await kv(["SET", BAL_KEY, JSON.stringify(o)]); }

async function verify(idToken) {
  if (!idToken) return null;
  try {
    const r = await fetch("https://oauth2.googleapis.com/tokeninfo?id_token=" + encodeURIComponent(idToken));
    if (!r.ok) return null;
    const p = await r.json();
    if (p.aud !== CLIENT_ID) return null;
    if (p.email_verified !== "true" && p.email_verified !== true) return null;
    return (p.email || "").toLowerCase();
  } catch (e) { return null; }
}
async function isAdmin(email) {
  if (!email) return false;
  if (email === SUPER_ADMIN) return true;
  try {
    const raw = await kv(["GET", "pvh:acl"]);
    const o = raw ? (typeof raw === "string" ? JSON.parse(raw) : raw) : {};
    const u = (o.users || {})[email];
    return !!(u && u.role === "admin");
  } catch (e) { return false; }
}

/* ===== Galaxylink B2B API — auth theo tài liệu: sign = SHA256(api_key + timestamp) → X-Access-Token ===== */
const GLX_BASE = "https://api.galaxylink.gg";
// tài liệu (bản 20.07.2026) chưa công bố endpoint số dư → dò lần lượt các đường dẫn khả dĩ, nhớ lại đường dẫn dùng được
const GLX_PATHS = ["/client/balance", "/balance", "/client/info", "/client/me", "/client", "/profile", "/me", "/auth/me", "/account", "/wallet"];

async function glxToken() {
  const id = parseInt(process.env.GLX_CLIENT_ID || "0", 10);
  const key = process.env.GLX_API_KEY || "";
  if (!id || !key) throw new Error("chua_khai_bao_env_GLX_CLIENT_ID_GLX_API_KEY");
  const ts = Math.floor(Date.now() / 1000);
  const sign = crypto.createHash("sha256").update(key + ts).digest("hex");
  const r = await fetch(GLX_BASE + "/auth/token", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ client_id: id, timestamp: ts, sign })
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || !j.token) throw new Error("auth_that_bai_" + r.status + (j.message ? "_" + j.message : ""));
  return j.token;
}
// tìm đệ quy trường số dư trong JSON trả về (balance / wallet / credit) — ưu tiên key đúng tên "balance"
function findBalance(o, path) {
  path = path || "";
  let best = null;
  if (o && typeof o === "object") {
    for (const k of Object.keys(o)) {
      const v = o[k], p = path ? path + "." + k : k;
      if (/balance|wallet|credit/i.test(k) && !/debit/i.test(k)) {
        const n = typeof v === "number" ? v : (typeof v === "string" && /^-?\d+(\.\d+)?$/.test(v.trim()) ? parseFloat(v) : NaN);
        if (!isNaN(n)) {
          const cand = { value: n, path: p, exact: k.toLowerCase() === "balance" };
          if (!best || (cand.exact && !best.exact)) best = cand;
        }
      }
      if (v && typeof v === "object") {
        const sub = findBalance(v, p);
        if (sub && (!best || (sub.exact && !best.exact))) best = sub;
      }
    }
  }
  return best;
}
async function glxBalance(store) {
  const token = await glxToken();
  const paths = store.glxPath ? [store.glxPath].concat(GLX_PATHS.filter(x => x !== store.glxPath)) : GLX_PATHS;
  const probes = [];
  for (const p of paths) {
    let status = 0, body = "", j = null;
    try {
      const r = await fetch(GLX_BASE + p, { headers: { "X-Access-Token": token } });
      status = r.status; body = await r.text();
      try { j = JSON.parse(body); } catch (e) {}
    } catch (e) { body = "" + (e && e.message ? e.message : e); }
    probes.push({ path: p, status, body: body.slice(0, 200) });
    if (status === 200 && j) {
      const f = findBalance(j);
      if (f) { store.glxPath = p; return { usd: f.value, path: p, field: f.path, probes }; }
    }
  }
  return { usd: null, probes };
}

module.exports = async (req, res) => {
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Cache-Control", "no-store");
  const send = o => res.status(200).send(JSON.stringify(o));
  if (!KV_URL || !KV_TOKEN) { send({ error: "kv_not_configured" }); return; }

  let body = {};
  try { if (req.method === "POST") body = (req.body && typeof req.body === "object") ? req.body : JSON.parse(req.body || "{}"); } catch (e) {}
  const q = req.query || {};
  const a = q.a || body.a || "get";

  // cron gọi bằng secret; người dùng gọi bằng id_token Google và phải là admin
  const secret = process.env.NCC_SECRET || "";
  const secretOk = !!secret && (q.s === secret || body.s === secret);
  let email = null;
  if (!secretOk) {
    email = await verify(body.id_token || q.id_token || "");
    if (!email) { send({ error: "unauthorized" }); return; }
    if (!(await isAdmin(email))) { send({ error: "forbidden" }); return; }
  }

  const store = await getStore();

  if (a === "get") {
    const nccs = NCCS.map(n => Object.assign({}, n, store.balances[n.id] || {}));
    send({ ok: true, nccs });
    return;
  }

  if (a === "set") {
    const id = body.ncc || q.ncc || "";
    if (!NCCS.some(n => n.id === id)) { send({ error: "ncc_khong_hop_le" }); return; }
    if (body.del || q.del) {
      delete store.balances[id];
    } else {
      const usd = parseFloat(body.usd != null ? body.usd : q.usd);
      if (isNaN(usd) || usd < 0) { send({ error: "so_du_khong_hop_le" }); return; }
      store.balances[id] = { usd, ts: Date.now(), src: "tay", by: email || "cron", note: ("" + (body.note || "")).slice(0, 120) };
    }
    await setStore(store);
    send({ ok: true });
    return;
  }

  if (a === "poll") {
    const results = {};
    try {
      const g = await glxBalance(store);
      if (g.usd != null) {
        store.balances.glx = { usd: g.usd, ts: Date.now(), src: "api", field: g.field };
        results.glx = { ok: true, usd: g.usd, path: g.path, field: g.field };
      } else {
        results.glx = { ok: false, error: "khong_tim_thay_endpoint_so_du", probes: g.probes };
      }
    } catch (e) {
      results.glx = { ok: false, error: "" + (e && e.message ? e.message : e) };
    }
    await setStore(store);
    send({ ok: true, results });
    return;
  }

  send({ error: "unknown_action" });
};
