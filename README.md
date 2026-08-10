# SGF Discord Bot

Bot Discord cho SGF gồm 3 phần trong một service:

- **Temporary voice rooms:** member click vào voice trigger → bot tạo phòng tạm và kéo member vào; phòng tự xóa khi trống.
- **Premium:** creator channel `free` chỉ tạo phòng; creator channel `premium` cho phép chủ phòng đổi tên, giới hạn người, khóa/mở và ẩn/hiện bằng button.
- **SePay/VietQR:** tạo đơn có mã `SGF-BUY-XXXXXXXX` hoặc `SGF-DON-XXXXXXXX`, hiển thị QR, nhận webhook tiền vào, ghi ledger và tự cấp role.
- **Dashboard:** Discord OAuth; mọi thành viên của server có thể vào Cửa hàng, owner/Administrator mới thấy Control Center để cấu hình server.
- **SGF integration:** API server-to-server cho domain SGF lấy donor, payment và entitlement.

## Stack

- Node.js 20+ / TypeScript / Express 5
- discord.js 14
- SQLite + better-sqlite3 (đủ cho một bot; có thể chuyển adapter sang PostgreSQL khi scale lớn)
- Dashboard dùng TypeScript source tại `src/web/*.ts`, compile thành browser JavaScript tại `public/*.js` (trình duyệt không chạy trực tiếp TypeScript).

## Chạy local

```bash
cp .env.example .env
npm install
npm run build
npm run dev
```

Mở `http://localhost:3000`. Database local nằm ở `data/sgf.sqlite`. Ứng dụng không tạo tài khoản Discord giả và luôn yêu cầu OAuth thật.

## 1. Tạo Discord application

### Sửa lỗi `OAuth2 redirect_uri không hợp lệ`

Discord kiểm tra `redirect_uri` theo kiểu **khớp tuyệt đối**. Nếu chạy local, thêm đúng dòng này trong Discord Developer Portal → **OAuth2 → General → Redirects**:

```text
http://localhost:3000/auth/discord/callback
```

Và `.env` phải có cùng giá trị:

```env
PUBLIC_URL=http://localhost:3000
DISCORD_REDIRECT_URI=http://localhost:3000/auth/discord/callback
```

Không thêm dấu `/` ở cuối, không dùng `127.0.0.1` thay cho `localhost`, và sau khi đổi `.env` phải restart Node. Nếu chạy domain thì thay cả hai bằng URL HTTPS thật, ví dụ `https://bot.sgf.vn/auth/discord/callback`. URL nhìn thấy trên thanh địa chỉ phải trùng đúng redirect đã khai báo.

Ảnh lỗi `400 Bad Request` trước đây là lỗi redirect nên chưa chạy tới callback. Nếu callback chạy nhưng hiện `Không đổi được OAuth code`, bot sẽ log chi tiết Discord trả về. Các trường hợp thường gặp:

- `invalid_client`: `DISCORD_CLIENT_SECRET` sai, đang dùng Public Key/Bot Token, hoặc secret thuộc application khác. Lấy lại Client Secret trong đúng application có Client ID.
- `invalid_grant`: code đã bị dùng/refresh lại callback, hoặc redirect URI ở bước đổi token không giống bước authorize. Đóng tab callback và bấm login lại từ trang dashboard.
- `invalid_request`: thiếu biến môi trường hoặc `.env` chưa được load.

Mở `http://localhost:3000/api/runtime` để kiểm tra `clientId`, `clientSecretConfigured` và `redirectUri` mà process thật sự đang dùng. Không gửi client secret hoặc token lên chat.

1. Vào Discord Developer Portal → tạo Application.
2. Tab **Bot** → tạo bot, lấy token vào `DISCORD_TOKEN`.
3. Bật các intent cần thiết:
   - `SERVER MEMBERS INTENT` để cấp role và kiểm tra member.
   - Voice state events được dùng để nhận click vào creator channel.
4. OAuth2 → Redirects thêm chính xác:
   - local: `http://localhost:3000/auth/discord/callback`
   - production: `https://bot.sgf-domain.vn/auth/discord/callback`
5. Invite bot với scopes `bot applications.commands` và các quyền tối thiểu:
   - View Channels
   - Manage Channels
   - Move Members
   - Connect / Speak
   - Send Messages / Embed Links
   - Manage Roles (để cấp role Premium)
6. Role của bot phải đứng **cao hơn** role Premium cần cấp.

Invite bot phải có cả hai scope:

```text
bot applications.commands
```

Nếu chỉ invite bằng scope `bot`, bot vẫn có thể online nhưng slash command không hiện. Sau khi bot online, code sẽ đăng ký **guild command** ngay lập tức nên không cần chờ global command cache. Gõ `/sgf` rồi sẽ thấy các subcommand `setup`, `panel`, `status`, `sync`, `premium`, `room`, `help`. Nếu chưa thấy, kiểm tra log có dòng `[bot] logged in as ...`, dùng `/sgf sync` sau khi invite lại, hoặc mời lại bot bằng URL có `applications.commands`.

Chỉ có một slash command gốc là `/sgf` với các subcommand:

- `/sgf setup`: lấy link dashboard/webhook và kiểm tra setup.
- `/sgf panel`: đăng/cập nhật payment panel có button mua role/donate.
- `/sgf status`: xem nhanh trạng thái.
- `/sgf sync`: đăng ký lại slash command.
- `/sgf premium`: member mở menu mua role/donate.
- `/sgf room`: member mở control panel phòng của mình.
- `/sgf help`: xem hướng dẫn.

Member bình thường không cần slash command; chỉ click voice trigger và button panel.

## 2. Cấu hình Dashboard

Đăng nhập bằng Discord OAuth, chọn server mà account là thành viên và bot có quyền `Administrator`. Member thường chỉ thấy **Cửa hàng**; account có `Administrator` hoặc là owner mới thấy toàn bộ Control Center.

### Thành viên server

Admin có thể mở mục **Thành viên** để bot fetch toàn bộ member trong đúng server, bao gồm Discord ID, username, display name, avatar URL, role, trạng thái Premium và tổng các giao dịch đã thanh toán. Nếu chưa có giao dịch, dashboard hiển thị rõ chưa có thành viên nào mua Premium.

### Voice rooms

Có thể bấm **Tạo voice trigger** ngay trên Dashboard để bot tạo voice channel mới, hoặc thêm channel ID có sẵn bằng form. Creator channel tạo mới sẽ tự được lưu vào cấu hình.

Thêm nhiều creator channel:

| Field | Ý nghĩa |
|---|---|
| Channel ID | Voice channel member sẽ click để tạo phòng |
| Mode `free` | Mem thường tạo phòng, không mở control chỉnh sửa |
| Mode `premium` | Chỉ member có Premium entitlement/role mới được tạo; có control button |
| Category ID | Category riêng cho phòng đó; để trống dùng category mặc định |

Cấu hình thêm:

- **Tên phòng template:** `{user}'s room`, hỗ trợ `{user}` và `{tag}`.
- **Control channel:** bot gửi panel điều khiển của các phòng vào đây.
- **Payment panel channel:** kênh để `/sgf panel` đăng button mua/donate.
- **Premium role ID:** role mặc định để bot kiểm tra quyền và cấp sau thanh toán.

Room không cấp `Manage Channels` cho member. Bot giữ quyền quản lý để member chỉ đổi được đúng các thao tác mà button cho phép.

### Premium & giá

Tạo bao nhiêu gói tùy ý:

- Tên, mô tả, giá VND.
- Thời hạn ngày; `0` nếu không hết hạn.
- Role ID riêng; để trống sẽ dùng Premium role mặc định.
- Có thể tắt gói mà không xóa lịch sử payment.

### Payment panel

Sau khi có product và payment panel channel, bấm **Đăng payment panel** hoặc dùng `/sgf panel`. Bot tạo một message:

- Mỗi product là một button mua trực tiếp.
- Một button Donate mở modal nhập số tiền/lời nhắn.
- Sau click, bot trả QR trong tin nhắn riêng; không cần đi qua nhiều tầng menu.

## 3. VietQR và SePay: chọn luồng nào?

### QR tĩnh bạn đang có

QR tĩnh chỉ chứa thông tin thụ hưởng (ngân hàng/STK). Nó giúp người chuyển quét nhanh nhưng **bản thân QR không biết giao dịch đã thành công** và không tự cấp role. Trong starter này QR tĩnh vẫn được hỗ trợ: bot hiển thị mã đơn duy nhất, người dùng phải nhập mã đó vào nội dung chuyển khoản.

### QR động khuyến nghị

Nếu cấu hình `bankCode` + `bankAccountNumber` trong Dashboard hoặc `.env`, bot tạo URL QR động dạng:

```text
https://vietqr.app/img?acc=...&bank=...&amount=...&des=SGF-BUY-XXXXXXXX
```

QR này điền sẵn số tiền và mã đơn. SePay nhận biến động số dư từ tài khoản đã kết nối rồi gọi webhook về server. Bot kiểm tra:

1. API key webhook.
2. Tiền vào, không phải tiền ra.
3. Mã `SGF-BUY-XXXXXXXX` / `SGF-DON-XXXXXXXX`.
4. Số tiền không thấp hơn đơn.
5. Transaction ID chưa xử lý trước đó.

Sau đó product payment được đánh `paid`, bot cấp role và ghi entitlement. Webhook có idempotency nên gửi lại cùng transaction không cấp trùng.

### Cấu hình SePay

Trong SePay, tạo webhook với:

- URL: `https://<domain-bot>/api/payments/sepay/webhook`
- Event: giao dịch tiền vào (`In_only` nếu dashboard SePay có lựa chọn này)
- Authentication: API Key
- API key: điền vào `SEPAY_WEBHOOK_API_KEY`
- Có thể bật bỏ qua giao dịch không có mã nếu muốn giảm noise

Có thể dùng tài khoản cá nhân/doanh nghiệp theo khả năng tài khoản SePay của bạn. Đừng commit `.env` hoặc API key.

## 4. Tích hợp domain SGF

Bot server giữ dữ liệu payment; domain SGF không cần truy cập SQLite. Dùng các endpoint:

```text
GET /api/integrations/sgf/payments?guildId=SERVER_ID
GET /api/integrations/sgf/entitlements?guildId=SERVER_ID
GET /api/integrations/sgf/entitlements?guildId=SERVER_ID&discordUserId=USER_ID
```

Gửi header server-to-server:

```http
X-SGF-Secret: <SGF_INTEGRATION_SECRET>
```

Secret chỉ nằm ở backend domain SGF. Không gọi endpoint này trực tiếp từ trình duyệt public.

Nếu muốn SGF nhận event ngay khi thanh toán thành công, cấu hình thêm:

```env
SGF_EVENTS_WEBHOOK_URL=https://sgf-domain.vn/api/bot-events
```

Bot sẽ POST event `payment.paid` kèm payment object và Bearer `SGF_INTEGRATION_SECRET`.

## API chính

| Method | Route | Dùng cho |
|---|---|---|
| `GET` | `/api/health` | health check |
| `GET` | `/auth/discord` | login OAuth |
| `GET` | `/api/guilds` | server user là thành viên và bot có quyền admin |
| `GET` | `/api/guilds/:guildId/members` | admin fetch toàn bộ member + payment summary |
| `PUT` | `/api/guilds/:guildId/settings` | cấu hình voice/payment |
| `POST/PUT/DELETE` | `/api/guilds/:guildId/products...` | bảng giá |
| `POST` | `/api/guilds/:guildId/payment-panel` | đăng button panel |
| `POST` | `/api/payments/sepay/webhook` | SePay gọi vào |
| `GET` | `/api/integrations/sgf/payments` | SGF lấy donor/payment |
| `GET` | `/api/integrations/sgf/entitlements` | SGF lấy role entitlement |

## Production checklist

- [ ] `NODE_ENV=production`.
- [ ] `PUBLIC_URL` là HTTPS thật.
- [ ] OAuth redirect trên Discord khớp 100% với domain.
- [ ] `SESSION_SECRET`, `SEPAY_WEBHOOK_API_KEY`, `SGF_INTEGRATION_SECRET` là chuỗi random dài.
- [ ] Reverse proxy chuyển HTTPS về port Node, websocket không bắt buộc.
- [ ] Volume persistent cho `data/sgf.sqlite` hoặc chuyển DB sang Postgres.
- [ ] Backup database; không expose file SQLite.
- [ ] Bot có role cao hơn Premium role nhưng thấp hơn role admin.
- [ ] Test SePay webhook trên staging trước khi bật auto cấp role.
