# Bot giao việc `@trolyquynhhtn` — hướng dẫn cài đặt

Bot đọc tin nhắn bạn **tag nó** trong box Telegram, tách ra *ai làm · việc gì · hạn khi nào*,
ghi vào Google Sheet, rồi tự nhắc cho tới khi việc xong.

Toàn bộ chạy trên hạ tầng miễn phí: Vercel Hobby + Upstash KV + Google Apps Script + GitHub Actions.

---

## 1. Google Sheet (5 phút)

1. Mở file Sheet quản trị công việc → **Tiện ích mở rộng → Apps Script**
2. Xoá hết nội dung `Code.gs`, dán toàn bộ [`apps-script/Code.gs`](apps-script/Code.gs)
3. Sửa dòng `var SECRET = 'doi-chuoi-nay-di-1234';` thành một chuỗi bí mật của bạn
4. **Triển khai → Tuỳ chọn triển khai mới → Ứng dụng web**
   - Thực thi với tư cách: **Tôi**
   - Ai có quyền truy cập: **Bất kỳ ai**
5. Copy URL kết thúc bằng `/exec`

Script tự tạo 2 tab `VIEC` và `NHAT_KY`, và tự thêm 4 cột `phong` · `vai_tro` · `bi_danh` · `tg_id`
vào tab nhân sự sẵn có. **Tab lịch cũ không bị đụng tới.**

### Điền nốt bảng nhân sự

| Tên nhân viên | Tele | phong | vai_tro | bi_danh |
|---|---|---|---|---|
| QuangLM | @quangdino | VH | leader | Quang, quang lm, a Quang |
| HaDT | @Thuhaneee | HR | nhanvien | Hà, ha dt, c Hà |
| … | | | | |

- `phong`: `VH` / `HR` / `KT` — quyết định bot bắn vào box nào
- `vai_tro`: `leader` / `nhanvien` — quyết định leo thang báo cho ai
- `bi_danh`: mọi cách bạn hay gọi người đó, cách nhau bởi dấu phẩy. **Không được trùng giữa hai người.**

Bot đọc lại bảng này mỗi 10 phút → thêm người không cần deploy lại.

---

## 2. Biến môi trường trên Vercel

`Project Settings → Environment Variables`

| Biến | Giá trị |
|---|---|
| `TASKBOT_TOKEN` | token BotFather cấp cho `@trolyquynhhtn` |
| `TASKBOT_USERNAME` | `trolyquynhhtn` |
| `TASKBOT_SECRET` | chuỗi tự đặt — dùng cho webhook và cho `/api/remind` |
| `GS_WEBAPP_URL` | URL `/exec` ở bước 1 |
| `GS_SECRET` | đúng chuỗi `SECRET` trong `Code.gs` |
| `TG_VH`, `TG_HR`, `TG_KT` | chat ID 3 box (bước 3) |
| `BOSS_TG_ID` | Telegram user ID của bạn — nhận báo cáo sáng |
| `KV_REST_API_URL`, `KV_REST_API_TOKEN` | đã có sẵn từ dashboard |

Deploy lại sau khi thêm biến.

---

## 3. Nối webhook và lấy chat ID

Thay `<TOKEN>` và `<SECRET>`, mở trên trình duyệt:

```
https://api.telegram.org/bot<TOKEN>/setWebhook?url=https://<domain-vercel>/api/bot&secret_token=<SECRET>
```

Rồi thêm bot vào từng box và gõ `/id` — bot trả về chat ID để điền vào bước 2.

> Đặt webhook **không ảnh hưởng** `api/tele.js`. File đó chỉ *gửi*; webhook chỉ chi phối chiều *nhận*.
> Báo cáo PVH10 vẫn chạy như cũ.

---

## 4. Bật bộ nhắc

`GitHub → Settings → Secrets and variables → Actions → New repository secret`

- Tên: `TASK_REMIND_URL`
- Giá trị: `https://<domain-vercel>/api/remind?key=<TASKBOT_SECRET>`

Chạy thử không gửi thật: tab **Actions → Nhac viec → Run workflow → dry = 1**

---

## 5. Mỗi người `/start` một lần

Telegram không cho bot nhắn trước cho người chưa từng mở hội thoại với nó.
Nhờ cả 7 người nhắn `/start` cho `@trolyquynhhtn` — bot tự ghi `tg_id` vào Sheet.

Chưa `/start` thì bot vẫn chạy, chỉ là nhắc trong box thay vì nhắn riêng.

---

## Cách dùng

```
@trolyquynhhtn Quang đối soát NCC Galaxylink 17h mai
```

Bot đọc được các mốc thời gian sau:

| Gõ | Hiểu là |
|---|---|
| `17h` · `17:00` · `5h chiều` · `9h sáng` · `8h tối` | giờ trong ngày |
| `mai` · `mốt` · `ngày kia` | ngày tương đối |
| `t6` · `thứ 6` · `cn` · `chủ nhật` | thứ gần nhất |
| `15/08` · `15/8` | ngày cụ thể |
| `cuối tuần` · `đầu tuần` · `tuần sau` · `trong tuần` | mốc tuần |
| `trong ngày` · `cuối ngày` | 18:00 hôm nay |
| `gấp` · `khẩn` | +2 giờ, ưu tiên cao |
| *(không có gì)* | 18:00 hôm nay, kèm cảnh báo |

Ghép được: `17h mai`, `9h sáng t6`, `8h tối 20/8`.

**Lệnh:** `/start` đăng ký · `/viec` việc của tôi · `/id` chat ID · `/ping` kiểm tra bot sống

**Nút bấm:** người làm có `✅ Nhận` `🏁 Xong` `⏰ Xin gia hạn` `❓ Vướng`;
người giao có `✏️ Sửa hạn` `👤 Đổi người` `🗑 Huỷ`.

---

## Thang nhắc

| Mốc | Bot làm gì | Ai nhận |
|---|---|---|
| Giao + 30′ chưa Nhận | nhắc lại | nhắn riêng người làm |
| Giao + 2h chưa Nhận | báo lên | leader phòng |
| Hạn − 1 ngày | nhắc trước | nhắn riêng |
| Hạn − 2h | nhắc gấp | nhắn riêng |
| Quá hạn | tag đích danh | box của phòng |
| Quá hạn + 2h | báo trễ | leader phòng |
| 08:00 hằng ngày | việc trễ · đến hạn · chưa ai nhận | bạn |
| 20:00 hằng ngày | chốt ngày theo phòng | 3 box |

Mỗi mốc chỉ bắn **một lần** (khoá trong KV), nên cron gõ cửa trùng hay trễ đều vô hại.

---

## Giới hạn cần biết

- **Một tin = một việc.** Gõ 2 việc trong một tin thì bot chỉ ghi 1.
- Tên gọi lạ chưa có trong `bi_danh` → bot hỏi lại bằng nút, không đoán bừa.
- Nhắc có thể trễ tối đa 30 phút (nhịp quét), và GitHub Actions đôi khi nhả job muộn hơn nữa.
- GitHub Actions: ~960 phút/tháng cho bộ nhắc. Cộng workflow báo cáo sẵn có là ~1.770/2.000 phút
  miễn phí của repo private. Sát trần — nếu cần dư thì nới nhịp quét lên 45 phút, hoặc để repo public.
