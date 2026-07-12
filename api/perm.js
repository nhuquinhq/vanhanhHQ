// Vercel Serverless Function — Quản lý tài khoản & phân quyền (Vercel KV / Upstash Redis)
// Lưu ACL riêng tư ở KV; verify đăng nhập Google phía server qua tokeninfo.
// Actions: me (sau đăng nhập) · list/assign/remove/dismiss (chỉ admin)
const CLIENT_ID = "195227450871-agk96k2h1897lnvgjk7uorfoe2q9dqqi.apps.googleusercontent.com";
const SUPER_ADMIN = "quynhhtn@hqplay.vn";

const KV_URL = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL || "";
const KV_TOKEN = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN || "";

async function kv(cmd) {
  const r = await fetch(KV_URL, {
    method: "POST",
    headers: { Authorization: "Bearer " + KV_TOKEN, "Content-Type": "application/json" },
    body: JSON.stringify(cmd)
  });
  const j = await r.json();
  return j.result;
}
async function getAcl() {
  try {
    const raw = await kv(["GET", "pvh:acl"]);
    if (!raw) return { users: {}, pending: [] };
    const o = typeof raw === "string" ? JSON.parse(raw) : raw;
    return { users: o.users || {}, pending: o.pending || [] };
  } catch (e) { return { users: {}, pending: [] }; }
}
async function setAcl(acl) { await kv(["SET", "pvh:acl", JSON.stringify(acl)]); }

// verify id_token Google — không cần thư viện, dùng endpoint tokeninfo
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
function meOf(acl, email) {
  if (email === SUPER_ADMIN) return { role: "admin", pages: "all" };
  return acl.users[email] || null;
}

module.exports = async (req, res) => {
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Cache-Control", "no-store");
  if (!KV_URL || !KV_TOKEN) { res.status(200).send(JSON.stringify({ error: "kv_not_configured" })); return; }

  let body = {};
  try { if (req.method === "POST") body = (req.body && typeof req.body === "object") ? req.body : JSON.parse(req.body || "{}"); } catch (e) {}
  const action = (req.query && req.query.action) || body.action || "me";
  const idToken = body.id_token || (req.query && req.query.id_token) || "";

  const email = await verify(idToken);
  if (!email) { res.status(200).send(JSON.stringify({ error: "unauthorized" })); return; }

  const acl = await getAcl();
  const me = meOf(acl, email);

  if (action === "me") {
    if (me) { res.status(200).send(JSON.stringify({ email, status: "ok", role: me.role, pages: me.pages })); return; }
    // đăng nhập lần đầu chưa có quyền → ghi vào danh sách chờ
    if (acl.pending.indexOf(email) === -1) { acl.pending.push(email); await setAcl(acl); }
    res.status(200).send(JSON.stringify({ email, status: "pending", admin: SUPER_ADMIN }));
    return;
  }

  // các action quản lý — chỉ admin
  if (!me || me.role !== "admin") { res.status(200).send(JSON.stringify({ error: "forbidden" })); return; }

  if (action === "list") {
    res.status(200).send(JSON.stringify({ users: acl.users, pending: acl.pending, superAdmin: SUPER_ADMIN }));
    return;
  }
  if (action === "assign") {
    const t = (body.email || "").toLowerCase();
    if (!t || t.indexOf("@") < 0) { res.status(200).send(JSON.stringify({ error: "bad_email" })); return; }
    if (t === SUPER_ADMIN) { res.status(200).send(JSON.stringify({ error: "is_super_admin" })); return; }
    const role = ["admin", "leader", "nhanvien"].indexOf(body.role) > -1 ? body.role : "nhanvien";
    let pages = body.pages; // 'all' | mảng mã | null (mặc định vai trò)
    if (pages !== "all" && !Array.isArray(pages)) pages = null;
    acl.users[t] = { role, pages };
    acl.pending = acl.pending.filter(x => x !== t);
    await setAcl(acl);
    res.status(200).send(JSON.stringify({ ok: true }));
    return;
  }
  if (action === "remove") {
    const t = (body.email || "").toLowerCase();
    delete acl.users[t];
    acl.pending = acl.pending.filter(x => x !== t);
    await setAcl(acl);
    res.status(200).send(JSON.stringify({ ok: true }));
    return;
  }
  if (action === "dismiss") {
    const t = (body.email || "").toLowerCase();
    acl.pending = acl.pending.filter(x => x !== t);
    await setAcl(acl);
    res.status(200).send(JSON.stringify({ ok: true }));
    return;
  }
  res.status(200).send(JSON.stringify({ error: "unknown_action" }));
};
