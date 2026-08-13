/**
 * Cầu nối Google Sheet ↔ bot giao việc.
 * Dán file này vào: Sheet → Tiện ích mở rộng → Apps Script → thay toàn bộ Code.gs
 * Rồi: Triển khai → Tuỳ chọn triển khai mới → Ứng dụng web
 *      • Thực thi với tư cách: Tôi
 *      • Ai có quyền truy cập: Bất kỳ ai
 * Copy URL /exec ra, bỏ vào biến môi trường GS_WEBAPP_URL trên Vercel.
 *
 * ĐỔI CHUỖI BÍ MẬT bên dưới, và đặt đúng chuỗi đó vào biến GS_SECRET trên Vercel.
 */
var SECRET = 'doi-chuoi-nay-di-1234';

var TAB_VIEC = 'VIEC';
var TAB_LOG = 'NHAT_KY';
var COT_VIEC = ['ma', 'ngay_giao', 'noi_dung', 'pic', 'han', 'box_ten', 'phong', 'trang_thai',
  'uu_tien', 'nguoi_giao_ten', 'luc_nhan', 'luc_xong', 'so_lan_doi_han', 'link_tin'];
/* Các cột sẽ được tự thêm vào tab nhân sự nếu chưa có */
var COT_NS_THEM = ['phong', 'vai_tro', 'bi_danh', 'tg_id'];

function bo_dau_(s) {
  return String(s == null ? '' : s).normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/đ/g, 'd').replace(/Đ/g, 'D').toLowerCase().trim();
}
function ss_() { return SpreadsheetApp.getActiveSpreadsheet(); }

/** Tìm tab nhân sự: ưu tiên tab tên NHAN_SU, không có thì dò tab nào chứa ô "Tên nhân viên" */
function sheetNhanSu_() {
  var ss = ss_(), sh = ss.getSheetByName('NHAN_SU');
  if (sh) return { sh: sh, hr: doHeader_(sh) };
  var all = ss.getSheets();
  for (var i = 0; i < all.length; i++) {
    var hr = doHeader_(all[i]);
    if (hr > 0) return { sh: all[i], hr: hr };
  }
  return null;
}
/** Trả về số dòng (1-based) của hàng tiêu đề có chứa "Tên nhân viên" */
function doHeader_(sh) {
  var n = Math.min(sh.getLastRow(), 30);
  if (n < 1) return 0;
  var vals = sh.getRange(1, 1, n, Math.max(sh.getLastColumn(), 1)).getValues();
  for (var r = 0; r < vals.length; r++)
    for (var c = 0; c < vals[r].length; c++) {
      var v = bo_dau_(vals[r][c]);
      if (v === 'ten nhan vien' || v === 'ho ten' || v === 'ten') return r + 1;
    }
  return 0;
}

/** Đọc bảng nhân sự, tự bổ sung các cột còn thiếu */
function docNhanSu_() {
  var f = sheetNhanSu_();
  if (!f) return [];
  var sh = f.sh, hr = f.hr;
  var lastCol = Math.max(sh.getLastColumn(), 1);
  var head = sh.getRange(hr, 1, 1, lastCol).getValues()[0].map(bo_dau_);

  /* thêm cột thiếu vào cuối hàng tiêu đề */
  for (var i = 0; i < COT_NS_THEM.length; i++) {
    if (head.indexOf(COT_NS_THEM[i]) === -1) {
      lastCol++;
      sh.getRange(hr, lastCol).setValue(COT_NS_THEM[i]).setFontWeight('bold');
      head.push(COT_NS_THEM[i]);
    }
  }
  var idx = function (ten) { return head.indexOf(ten); };
  var iTen = Math.max(idx('ten nhan vien'), idx('ho ten'), idx('ten'));
  var iTele = idx('tele') > -1 ? idx('tele') : idx('telegram');
  var iPhong = idx('phong'), iVaiTro = idx('vai_tro'), iBiDanh = idx('bi_danh'), iTgid = idx('tg_id');

  var nRow = sh.getLastRow() - hr;
  if (nRow < 1) return [];
  var rows = sh.getRange(hr + 1, 1, nRow, lastCol).getValues();
  var out = [];
  for (var r = 0; r < rows.length; r++) {
    var ten = String(rows[r][iTen] || '').trim();
    if (!ten) continue;
    out.push({
      ma: ten,
      ho_ten: ten,
      tele: String(rows[r][iTele] || '').trim(),
      phong: String(iPhong > -1 ? rows[r][iPhong] : '').trim().toUpperCase(),
      vai_tro: String(iVaiTro > -1 ? rows[r][iVaiTro] : '').trim().toLowerCase(),
      bi_danh: String(iBiDanh > -1 ? rows[r][iBiDanh] : '').trim(),
      tg_id: String(iTgid > -1 ? rows[r][iTgid] : '').trim(),
      _row: hr + 1 + r
    });
  }
  return out;
}

function ghiTgId_(ma, tgId) {
  var f = sheetNhanSu_(); if (!f) return false;
  var ds = docNhanSu_();
  var head = f.sh.getRange(f.hr, 1, 1, f.sh.getLastColumn()).getValues()[0].map(bo_dau_);
  var col = head.indexOf('tg_id') + 1;
  if (!col) return false;
  for (var i = 0; i < ds.length; i++)
    if (ds[i].ma === ma) { f.sh.getRange(ds[i]._row, col).setValue(String(tgId)); return true; }
  return false;
}

function sheetViec_() {
  var ss = ss_(), sh = ss.getSheetByName(TAB_VIEC);
  if (!sh) {
    sh = ss.insertSheet(TAB_VIEC);
    sh.getRange(1, 1, 1, COT_VIEC.length).setValues([COT_VIEC]).setFontWeight('bold');
    sh.setFrozenRows(1);
  }
  return sh;
}
function sheetLog_() {
  var ss = ss_(), sh = ss.getSheetByName(TAB_LOG);
  if (!sh) {
    sh = ss.insertSheet(TAB_LOG);
    sh.getRange(1, 1, 1, 4).setValues([['luc', 'ma', 'viec', 'ghi_chu']]).setFontWeight('bold');
    sh.setFrozenRows(1);
  }
  return sh;
}

function gio_(ms) { return ms ? new Date(Number(ms)) : ''; }

/** Ghi (hoặc cập nhật) một việc — tìm theo cột "ma" */
function upsertViec_(t) {
  var sh = sheetViec_();
  var dong = [t.ma, gio_(t.ngay_giao), t.noi_dung || '', t.pic || '', gio_(t.han),
  t.box_ten || '', t.phong || '', t.trang_thai || '', t.uu_tien || '',
  t.nguoi_giao_ten || '', gio_(t.luc_nhan), gio_(t.luc_xong),
  Number(t.so_lan_doi_han || 0), t.link_tin || ''];
  var n = sh.getLastRow() - 1;
  if (n > 0) {
    var mas = sh.getRange(2, 1, n, 1).getValues();
    for (var i = 0; i < mas.length; i++)
      if (String(mas[i][0]) === String(t.ma)) {
        sh.getRange(i + 2, 1, 1, dong.length).setValues([dong]);
        return { ok: true, row: i + 2, updated: true };
      }
  }
  sh.appendRow(dong);
  if (t.lich_su && t.lich_su.length)
    sheetLog_().appendRow([new Date(), t.ma, t.noi_dung || '', t.lich_su[t.lich_su.length - 1].v]);
  return { ok: true, row: sh.getLastRow(), updated: false };
}

function json_(o) {
  return ContentService.createTextOutput(JSON.stringify(o)).setMimeType(ContentService.MimeType.JSON);
}

function doPost(e) {
  var body = {};
  try { body = JSON.parse(e.postData.contents); } catch (err) { return json_({ ok: false, error: 'bad_json' }); }
  if (body.k !== SECRET) return json_({ ok: false, error: 'unauthorized' });

  var lock = LockService.getScriptLock();
  try { lock.waitLock(20000); } catch (err) { return json_({ ok: false, error: 'busy' }); }
  try {
    if (body.a === 'roster') return json_({ ok: true, list: docNhanSu_() });
    if (body.a === 'upsert') return json_(upsertViec_(body.task || {}));
    if (body.a === 'set_tgid') return json_({ ok: ghiTgId_(body.ma, body.tg_id) });
    if (body.a === 'log') { sheetLog_().appendRow([new Date(), body.ma || '', body.viec || '', body.ghi_chu || '']); return json_({ ok: true }); }
    if (body.a === 'ping') return json_({ ok: true, sheet: ss_().getName() });
    return json_({ ok: false, error: 'unknown_action' });
  } finally { lock.releaseLock(); }
}

function doGet() { return json_({ ok: true, hint: 'Dùng POST kèm {a, k}' }); }

/** Chạy tay một lần trong trình soạn thảo để kiểm tra */
function thu() { Logger.log(JSON.stringify(docNhanSu_(), null, 2)); }
