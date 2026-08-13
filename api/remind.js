// Bộ nhắc việc — GitHub Actions gõ cửa mỗi 30 phút trong giờ làm.
// Gọi: /api/remind?key=<TASKBOT_SECRET>[&dry=1]
// Mỗi mốc nhắc chỉ bắn đúng một lần (khoá NX trong KV), nên gõ cửa trùng cũng vô hại.
const L = require("./_lib");

const BOSS = process.env.BOSS_TG_ID || "";
const BOX = { VH: process.env.TG_VH, HR: process.env.TG_HR, KT: process.env.TG_KT };

/* Thang leo thang: mốc → (điều kiện, người nhận, nội dung) */
async function quetViec(now, roster, dry, log) {
  const ds = await L.dsMo(now + 2 * 86400000);
  const timNv = ma => roster.find(x => x.ma === ma) || null;
  const timLeader = phong => roster.find(x => x.phong === phong && x.vai_tro === "leader") || null;

  for (const t of ds) {
    if (t.trang_thai === "XONG" || t.trang_thai === "HUY") continue;
    const nv = timNv(t.pic);
    const chuaNhan = t.trang_thai === "MOI";
    const tuKhiGiao = now - (t.ngay_giao || now);
    const toiHan = t.han - now;
    const moc = [];

    if (chuaNhan && tuKhiGiao >= 30 * 60000) moc.push(["nhan30", "rieng",
      "⏳ <b>" + t.ma + "</b> giao 30 phút rồi mà chưa thấy bạn bấm Nhận.\n📋 " + t.noi_dung]);
    if (chuaNhan && tuKhiGiao >= 2 * 3600000) moc.push(["nhan2h", "leader",
      "⚠️ <b>" + t.ma + "</b> · " + (nv ? nv.ho_ten : "?") + " chưa nhận việc sau 2 tiếng.\n📋 " + t.noi_dung]);
    if (toiHan <= 86400000 && toiHan > 0) moc.push(["truoc1n", "rieng",
      "📅 <b>" + t.ma + "</b> hạn ngày mai — " + L.fmtHan(t.han) + "\n📋 " + t.noi_dung]);
    if (toiHan <= 2 * 3600000 && toiHan > 0) moc.push(["truoc2h", "rieng",
      "⏰ <b>" + t.ma + "</b> còn 2 tiếng nữa tới hạn!\n📋 " + t.noi_dung]);
    if (toiHan <= 0) moc.push(["quahan", "box",
      "🔴 <b>QUÁ HẠN</b> · " + t.ma + (nv && nv.tele ? " " + nv.tele : "") +
      "\n📋 " + t.noi_dung + "\n⏰ Hạn " + L.fmtHan(t.han) + " · " + L.fmtConLai(t.han, now)]);
    if (toiHan <= -2 * 3600000) moc.push(["quahan2h", "leader",
      "🔴 <b>" + t.ma + "</b> · " + (nv ? nv.ho_ten : "?") + " trễ quá 2 tiếng.\n📋 " + t.noi_dung]);

    for (const [ten, dich, text] of moc) {
      const khoa = "task:nhac:" + t.ma + ":" + ten;
      if (dry) { log.push("[dry] " + t.ma + " " + ten + " → " + dich); continue; }
      if (!(await L.kvLock(khoa, 7 * 86400))) continue;
      let sent = false;
      if (dich === "rieng") sent = await L.nhanRieng(nv, text, { reply_markup: L.nutNhan(t.ma) });
      if (dich === "box" || (dich === "rieng" && !sent)) {
        if (t.box) sent = !!(await L.guiTin(t.box, text, { reply_markup: L.nutNhan(t.ma) })).ok;
      }
      if (dich === "leader") {
        const ld = timLeader(t.phong);
        sent = await L.nhanRieng(ld, text);
        if (!sent && BOSS) sent = await L.nhanRieng({ tg_id: BOSS }, text);
      }
      if (!sent) await L.kv(["DEL", khoa]); /* gửi hỏng thì nhả khoá để lần quét sau thử lại */
      else log.push(t.ma + " " + ten + " → " + dich);
    }
  }
  return ds;
}

/* Bảng chốt cuối ngày theo phòng */
function bangPhong(ds, phong, now) {
  const cua = ds.filter(t => t.phong === phong);
  const xong = cua.filter(t => t.trang_thai === "XONG");
  const tre = cua.filter(t => t.trang_thai !== "XONG" && t.han < now);
  const treo = cua.filter(t => t.trang_thai !== "XONG" && t.han >= now);
  const out = ["📊 <b>Chốt ngày " + L.fmtNgay(now) + " · phòng " + phong + "</b>",
  "✅ Xong: " + xong.length + "  |  🔴 Trễ: " + tre.length + "  |  ⏳ Đang treo: " + treo.length];
  if (tre.length) {
    out.push("\n<b>Việc trễ:</b>");
    tre.slice(0, 15).forEach(t => out.push(" • " + t.ma + " — " + (t.noi_dung || "") + " (" + L.fmtConLai(t.han, now) + ")"));
  }
  return out.join("\n");
}

/* Báo cáo sáng cho sếp */
function bangSep(ds, now) {
  const tre = ds.filter(t => t.trang_thai !== "XONG" && t.han < now);
  const homNay = ds.filter(t => t.trang_thai !== "XONG" && t.han >= now && t.han < now + 86400000);
  const chuaNhan = ds.filter(t => t.trang_thai === "MOI");
  const out = ["🌅 <b>Sáng " + L.fmtNgay(now) + "</b>"];
  out.push("🔴 Trễ: " + tre.length + "  |  ⏰ Đến hạn hôm nay: " + homNay.length + "  |  🆕 Chưa ai nhận: " + chuaNhan.length);
  if (tre.length) { out.push("\n<b>Đang trễ:</b>"); tre.slice(0, 12).forEach(t => out.push(" • " + t.ma + " — " + (t.noi_dung || ""))); }
  if (chuaNhan.length) { out.push("\n<b>Giao rồi chưa nhận:</b>"); chuaNhan.slice(0, 12).forEach(t => out.push(" • " + t.ma + " — " + (t.noi_dung || ""))); }
  if (!tre.length && !chuaNhan.length) out.push("\n👍 Không có gì kẹt.");
  return out.join("\n");
}

module.exports = async (req, res) => {
  const q = req.query || {};
  const S = process.env.TASKBOT_SECRET || "";
  const isCron = !!req.headers["x-vercel-cron"] || /vercel-cron/i.test(req.headers["user-agent"] || "");
  if (S && !isCron && q.key !== S) { res.status(401).json({ error: "unauthorized" }); return; }

  const now = Date.now();
  const p = L.vnParts(now);
  const dry = !!q.dry;
  const log = [];

  try {
    const roster = await L.layNhanSu();
    if (!roster.length) { res.status(200).json({ ok: false, error: "chua_doc_duoc_bang_nhan_su" }); return; }

    const ds = await quetViec(now, roster, dry, log);

    /* mốc cố định trong ngày — nhận trong 1 tiếng sau mốc, mỗi ngày 1 lần */
    const ngay = p.y + "-" + L.pad2(p.m) + "-" + L.pad2(p.d);
    if (p.h === 8 && BOSS) {
      if (dry) log.push("[dry] bao cao sang");
      else if (await L.kvLock("task:bc:sang:" + ngay, 172800)) {
        await L.nhanRieng({ tg_id: BOSS }, bangSep(ds, now)); log.push("bao cao sang");
      }
    }
    if (p.h === 20) {
      for (const ph in BOX) {
        if (!BOX[ph]) continue;
        if (dry) { log.push("[dry] chot ngay " + ph); continue; }
        if (await L.kvLock("task:bc:chot:" + ngay + ":" + ph, 172800)) {
          await L.guiTin(BOX[ph], bangPhong(ds, ph, now)); log.push("chot ngay " + ph);
        }
      }
    }

    res.status(200).json({ ok: true, gio_vn: L.pad2(p.h) + ":" + L.pad2(p.mi), so_viec_mo: ds.length, da_lam: log });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e && e.message ? e.message : e), da_lam: log });
  }
};
