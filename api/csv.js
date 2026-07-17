// Vercel Serverless Function (CommonJS) — đọc CSV từ link PUBLISH của Google Sheet
// Gọi: /api/csv?gid=<gid>[&f=<file>]  (f=def: Dash Report PCU 2026 · f=ton: Tồn kho PVH6 · f=sla: SLA PVH10 · f=kho: Tồn kho chi tiết HQGROUP)
module.exports = async (req, res) => {
  const FILES = {
    def: "2PACX-1vSve6XRHg5gWRzqkazHm5zvlrkTkAMLa7TJms_U-ebAFcrDAmcvCYfNJ50hrvV988tXyKC7q70LQgPc",
    ton: "2PACX-1vQToyJFyIIxiDtucrAhxnTVZmjNWF2InPci5r-C75DfkHR6aQbUrmZNBcwDDadNrET82VwxtdjDhITE",
    sla: "2PACX-1vRHGRhq3zSjBYecJRUbTLwlgjvx-A7hIu8J0eSkUKuXZI7uMWYLjyUeIKefumrnQLC5jIbW55y0lE1W",
    kho: "2PACX-1vRdHQpyZ6zwGPYrrPX51UWzlHKunxOiHOCofQHSaCK_DCu_7-FZ-gdD-sVDT3t5uoYglVmggXDtziz5"
  };
  const ALLOW = {
    def: new Set([
      "460836856","1758921427","163849763","562469906","61864847",
      "1043029815","1868031300","793401472","1289659560","1711960798",
      "153250085","386815906","182113446"
    ]),
    ton: new Set(["0"]),
    sla: new Set(["1982526665","511745866","1496740945","287243650"]),
    kho: new Set(["1926394974"])
  };
  const f = String((req.query && req.query.f) || "def");
  const gid = String((req.query && req.query.gid) || "");
  if (!FILES[f] || !ALLOW[f].has(gid)) { res.status(400).send("nguon khong hop le: " + f + "/" + gid); return; }
  const url = "https://docs.google.com/spreadsheets/d/e/" + FILES[f] +
              "/pub?gid=" + gid + "&single=true&output=csv";
  try {
    const r = await fetch(url, { redirect: "follow" });
    const text = await r.text();
    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader("Content-Disposition", "inline");
    res.setHeader("Cache-Control", "s-maxage=30, stale-while-revalidate=120");
    res.status(200).send(text);
  } catch (e) {
    res.status(502).send("Loi doc Google Sheet: " + (e && e.message ? e.message : e));
  }
};
