# Git-Scan

**Git-Scan** là công cụ tự động quét các sự kiện công khai trên GitHub để phát hiện các private key EVM (Ethereum, BNB Chain, ...) bị lộ trong mã nguồn, kiểm tra số dư và tự động chuyển toàn bộ số dư về ví đích an toàn.

---

## 🚀 Tính năng nổi bật

- Theo dõi sự kiện GitHub Public Events (Push, Create Repository) để phát hiện private key bị lộ.
- Kiểm tra số dư các key trên nhiều mạng blockchain (Ethereum, BNB Chain).
- Tự động chuyển toàn bộ số dư về ví đích nếu phát hiện.
- Ghi log chi tiết các key, địa chỉ, số dư, link file chứa key.
- Tối ưu tốc độ, tránh trùng lặp, giảm request thừa nhờ cache và ETag.

---

## 🧩 Luồng hoạt động

1. **Khởi tạo & Đọc cấu hình**
   - Đọc các biến môi trường hoặc giá trị mặc định (token GitHub, thời gian quét, file log, ví đích, ...).
   - Đọc cache trạng thái các event đã xử lý, các key đã tìm thấy.

2. **Kiểm tra RPC**
   - Kiểm tra và ưu tiên các endpoint RPC nhanh nhất cho từng mạng blockchain.

3. **Theo dõi sự kiện GitHub**
   - Lấy các sự kiện mới nhất từ GitHub (PushEvent, CreateEvent).
   - Lưu lại các event đã xử lý để tránh trùng lặp.

4. **Quét commit mới (PushEvent)**
   - Lấy danh sách file thay đổi, chỉ quét file code/text.
   - Tìm kiếm private key, kiểm tra tính hợp lệ, kiểm tra số dư.
   - Nếu có số dư, tự động chuyển về ví đích, ghi log lại thông tin.

5. **Quét repository mới (CreateEvent)**
   - Đệ quy lấy danh sách file (ưu tiên thư mục phổ biến, giới hạn số lượng).
   - Quét từng file như trên.

6. **Kiểm tra số dư các private key đã thu thập**
   - Khi chạy với tham số `check-balance`, kiểm tra lại toàn bộ key đã lưu, ghi ra file các ví có số dư.

---

## ⚙️ Hướng dẫn cài đặt

### 1. Yêu cầu

- Node.js >= 16
- npm

### 2. Cài đặt thư viện

```bash
npm install
```

---

## 📝 Hướng dẫn sử dụng

### 1. Chạy quét sự kiện GitHub (mặc định)

```bash
node scan.js
```

### 2. Kiểm tra số dư các private key đã thu thập

```bash
node scan.js check-balance
```

### 3. Tuỳ chỉnh cấu hình qua biến môi trường (tùy chọn)

| Biến môi trường         | Ý nghĩa                                      | Giá trị mặc định                       |
|------------------------|-----------------------------------------------|----------------------------------------|
| GITHUB_TOKEN           | Token GitHub để tăng giới hạn API             | (token mẫu trong code)                 |
| CHECK_INTERVAL         | Thời gian giữa các lần quét (ms)              | 30000                                  |
| LOG_FILE               | File lưu các private key tìm thấy             | found_keys.txt                         |
| DEST_ADDRESS           | Địa chỉ ví đích để chuyển tiền                |                                        |
| MIN_AMOUNT             | Số dư tối thiểu để chuyển (ETH)               | 0.005                                  |
| SCAN_MODE              | Chế độ quét: all / new-repo / commit          | all                                    |
| BALANCE_CHECK_CONCURRENCY | Số lượng kiểm tra số dư đồng thời tối đa   | 5                                      |
| MAX_FILES_PER_REPO     | Số lượng file tối đa quét trong mỗi repo      | 100                                    |

Ví dụ:

```bash
GITHUB_TOKEN=your_token_here DEST_ADDRESS=your_wallet node scan.js
```

---

## 📂 File log & output

- **found_keys.txt**: Lưu thông tin các private key, địa chỉ, số dư, link file chứa key.
- **wallets_with_balance.txt**: Lưu các ví có số dư khi chạy `check-balance`.
- **etag_cache.json**: Cache ETag để tối ưu request GitHub.
- **seen_events.json**: Lưu các event đã xử lý để tránh trùng lặp.

---

## ⚠️ Cảnh báo

- **Chỉ sử dụng cho mục đích nghiên cứu, bảo mật, cảnh báo lộ lọt thông tin!**
- Không sử dụng cho mục đích xấu hoặc vi phạm pháp luật.

---

## 📧 Liên hệ

Nếu bạn có câu hỏi hoặc cần hỗ trợ, hãy mở issue hoặc liên hệ trực tiếp.

---

**Chúc bạn sử dụng tool hiệu quả!** 
