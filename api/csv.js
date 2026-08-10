// Vercel Serverless Function (CommonJS) — đọc CSV từ link PUBLISH của Google Sheet
// Gọi: /api/csv?gid=<gid>[&f=<file>]  (f=def: Dash Report PCU 2026 · f=ton: Tồn kho PVH6 · f=sla: SLA PVH10 · f=kho: Tồn kho chi tiết HQGROUP)
module.exports = async (req, res) => {
  const FILES = {
    def: "2PACX-1vSe-ef8TakONHHOrCz3zef2l8rbluKBwRFmOOIJKDXjU62zI91CM-9sPobr0kxyDUkNBmg3UA8Zssgn",
    def_old: "2PACX-1vSve6XRHg5gWRzqkazHm5zvlrkTkAMLa7TJms_U-ebAFcrDAmcvCYfNJ50hrvV988tXyKC7q70LQgPc",
    ton: "2PACX-1vQToyJFyIIxiDtucrAhxnTVZmjNWF2InPci5r-C75DfkHR6aQbUrmZNBcwDDadNrET82VwxtdjDhITE",
    sla: "2PACX-1vRHGRhq3zSjBYecJRUbTLwlgjvx-A7hIu8J0eSkUKuXZI7uMWYLjyUeIKefumrnQLC5jIbW55y0lE1W",
    kho: "2PACX-1vRdHQpyZ6zwGPYrrPX51UWzlHKunxOiHOCofQHSaCK_DCu_7-FZ-gdD-sVDT3t5uoYglVmggXDtziz5",
    gc13: "2PACX-1vSlOzVTuSNAfW-lVKF7xjLAPwVtnebtOFxCDiJKaseD8xQ9NfRpAWRQG-ivkUSMM83Tf1Ea2xnnRX_4",
    glx: "2PACX-1vT0ni4Ntgb0PgMYKwJGdrcYrA4P7t7Be0jem5w7n58dksNt3DrlzBDqSobmyRn9Bi0dFWDknEE9i2uJ",
    glx2: "2PACX-1vQq0flVcmBo_tCnguArmDmbqpTSPMoiAJUM7nRP1-R2LMECKMm6ofwiQC89Y9HXtJguwq600o7oDMie"
  };
  const ALLOW = {
    def: new Set([
      "460836856","1758921427","163849763","562469906","61864847",
      "1043029815","1868031300","793401472","1289659560","1711960798",
      "153250085","386815906","182113446","1267159006","564846337","1785292172"
    ]),
    ton: new Set(["0"]),
    sla: new Set(["1982526665","511745866","1496740945","287243650"]),
    kho: new Set(["1926394974"]),
    gc13: new Set(["505929777","1216897209"]),
    glx: new Set(["1473618411"]),
    glx2: new Set(["511652200"])
  };
  const f = String((req.query && req.query.f) || "def");
  const gid = String((req.query && req.query.gid) || "");
  if (!FILES[f] || !ALLOW[f] || !ALLOW[f].has(gid)) { res.status(400).send("nguon khong hop le: " + f + "/" + gid); return; }
  const mk = key => "https://docs.google.com/spreadsheets/d/e/" + key +
              "/pub?gid=" + gid + "&single=true&output=csv";
  const bad = t => !t || t.trimStart().slice(0, 200).toLowerCase().startsWith("<") || t.length < 40;
  try {
    const r = await fetch(mk(FILES[f]), { redirect: "follow" });
    let text = await r.text();
    // file "def" mới có thể chưa chứa tab cũ — rơi về file cũ để trang không bị trống
    if (f === "def" && bad(text)) {
      try { const r2 = await fetch(mk(FILES.def_old), { redirect: "follow" }); const t2 = await r2.text(); if (!bad(t2)) text = t2; } catch (e) {}
    }
    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader("Content-Disposition", "inline");
    res.setHeader("Cache-Control", "s-maxage=30, stale-while-revalidate=120");
    res.status(200).send(text);
  } catch (e) {
    res.status(502).send("Loi doc Google Sheet: " + (e && e.message ? e.message : e));
  }
};
