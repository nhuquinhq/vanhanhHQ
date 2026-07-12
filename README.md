# Trung tâm Báo cáo PVH — HQ Group

Dashboard vận hành nội bộ (PVH1–PVH12 + Tổng quan), lọc theo Ngày / Tháng / Năm.
Trang tĩnh (chỉ `index.html`), deploy thẳng lên Vercel.

## Cấu trúc
```
index.html     # toàn bộ dashboard (HTML + CSS + JS, dùng Chart.js qua CDN)
vercel.json    # cấu hình static + tắt cache để cập nhật nhanh
.gitignore
```

## Chạy thử ở máy
Mở trực tiếp `index.html` bằng trình duyệt là chạy (bản demo dùng số nhúng).

## Deploy lên Vercel qua GitHub (khuyên dùng — tự động deploy khi push)
1. Tạo repo mới trên GitHub, ví dụ `pvh-dashboard`.
2. Ở thư mục này chạy:
   ```bash
   git init
   git add .
   git commit -m "PVH dashboard - giao dien v1"
   git branch -M main
   git remote add origin https://github.com/<tài-khoản>/pvh-dashboard.git
   git push -u origin main
   ```
3. Vào https://vercel.com → **Add New… ▸ Project** → **Import** repo `pvh-dashboard`.
4. Framework Preset để **Other** (static), Root Directory `./`, bấm **Deploy**.
5. Xong — mỗi lần `git push` Vercel tự deploy lại.

## Deploy nhanh bằng Vercel CLI (không cần GitHub)
```bash
npm i -g vercel
vercel        # deploy preview
vercel --prod # deploy production
```

## Nguồn dữ liệu realtime
Web đọc **trực tiếp Google Sheet** qua link Publish-to-web CSV (`BASE?gid=…&output=csv`);
nếu link trực tiếp lỗi mới rơi về hàm dự phòng `/api/csv` trên Vercel.
Yêu cầu: file Google Sheet giữ chế độ **Publish to web** (Tệp ▸ Chia sẻ ▸ Xuất bản lên web).

Tình trạng nối dữ liệu:
- Chạy dữ liệu thật: Tổng quan, PVH1, PVH2, PVH3, PVH4, PVH5, PVH8, PVH9 (đơn Bot từ Data Razergold), PVH11.
- Số dự phòng khi không đọc được sheet: toàn bộ tự rơi về bộ số nhúng trong `index.html`.
- Chưa dựng (chờ chốt nguồn/nghiệp vụ): PVH6 (tồn & tuổi tồn), PVH7 (đối soát), PVH10 (SLA chi tiết).
- RBX: tab gid `1289659560` (CO ở cột G) sẽ nối khi có số liệu.

Kiểm tra nhanh: mở trang **Nguồn & Cấu hình** trong sidebar — bảng chẩn đoán test từng tab
theo cả 2 đường (Google trực tiếp / api dự phòng).
