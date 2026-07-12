// Vercel Serverless Function (CommonJS) — đọc CSV Google Sheet gốc qua gviz (không cần publish)
// Yêu cầu: file để chế độ "Bất kỳ ai có đường liên kết → Người xem"
// Gọi: /api/csv?gid=<gid>
module.exports = async (req, res) => {
  const SHEET_ID = "1g7a8MLo0DLo37-t3EsLd9js7BcaaIGcI57ufpQfbrlM";
  const ALLOW = new Set([
    "460836856","1758921427","163849763","562469906","61864847",
    "1043029815","1868031300","793401472","1289659560","1711960798"
  ]);
  const gid = String((req.query && req.query.gid) || "");
  if (!ALLOW.has(gid)) { res.status(400).send("gid khong hop le: " + gid); return; }
  const url = "https://docs.google.com/spreadsheets/d/" + SHEET_ID +
              "/gviz/tq?tqx=out:csv&gid=" + gid;
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
