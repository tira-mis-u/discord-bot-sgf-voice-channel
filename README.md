# SGF Discord Bot

Bot Discord cho SGF gồm các phần trong một service:

- **Temporary voice rooms:** member click vào một trong nhiều voice trigger → bot tạo phòng tạm và kéo member vào; phòng tự xóa khi trống.
- **Creator setting độc lập:** mỗi trigger chọn `basic` hoặc `editable`, category, role được phép tạo, log ra/vào và auto chuyển host riêng.
- **Room control:** panel nằm ngay trong chat của voice room; host/admin có thể đổi tên, limit, khóa, ẩn, password, mời, kick và chuyển ownership.
- **Premium theo user:** Free được 1 phòng editable trên mỗi server; Premium theo tháng không giới hạn, nhắc trước 3 ngày và gia hạn cộng tiếp từ ngày hết hạn.
- **SePay/VietQR:** tạo đơn có mã `SGF-BUY-XXXXXXXX` hoặc `SGF-DON-XXXXXXXX`, hiển thị QR, nhận webhook tiền vào, ghi ledger và tự cấp role.
- **Dashboard:** host quản lý toàn bộ phòng mình sở hữu; owner/Administrator quản lý tất cả phòng, member và creator setting của server.
- **SGF integration:** API server-to-server cho domain SGF lấy donor, payment và entitlement.

## Stack

- Node.js 20+ / TypeScript / Express 5
- discord.js 14
- Supabase PostgreSQL khi có `DATABASE_URL`; SQLite async fallback cho local development
- Redis hoặc Upstash cho session, cache, rate limit và distributed lock
- Dashboard dùng TypeScript source tại `src/web/*.ts`, compile thành browser JavaScript tại `public/*.js` (trình duyệt không chạy trực tiếp TypeScript).

## Chạy local

```bash
cp .env.example .env
npm install
npm run build
npm run dev
```

Mở `http://localhost:3000`. Database local nằm ở `data/sgf.sqlite`. Ứng dụng không tạo tài khoản Discord giả và luôn yêu cầu OAuth thật.

Không deploy toàn bộ service lên Vercel: Discord Gateway cần process chạy liên tục, còn Vercel Functions stateless và filesystem read-only. Khi phát hiện Vercel, code dùng `/tmp/sgf.sqlite` chỉ để tránh crash lúc khởi động; dữ liệu đó không persistent. Xem `DEPLOYMENT.md`.

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

Nếu chỉ invite bằng scope `bot`, bot vẫn có thể online nhưng slash command không hiện. Sau khi bot online, code đăng ký **guild command** ngay lập tức và tự đăng ký lại khi bot được thêm vào server mới, nên không cần chờ global command cache. Nếu chưa thấy lệnh, kiểm tra log có dòng `[bot] logged in as ...`, dùng `/sgf sync` sau khi invite lại, hoặc mời lại bot bằng URL có `applications.commands`.

Các lệnh nhanh:

Bot chỉ đăng ký một slash command gốc là `/sgf`. Các command độc lập cũ như `/setup`, `/help` và `/donate` được xóa khi bot đồng bộ command.

- `/sgf setup`: admin cấu hình creator channel, mode, allowed role, log ra/vào, auto host, payment channel và Premium role.
- `/sgf help`: mở embed hướng dẫn.
- `/sgf donate`: mở form tạo đơn donate riêng tư.
- `/sgf panel`: đăng payment panel vào đúng `payment_channel` đã thiết lập.
- `/sgf status`: xem trạng thái bot và server.
- `/sgf sync`: đăng ký lại `/sgf` và xóa command cũ bị trùng.
- `/sgf premium`: member mở menu Premium và donate.
- `/sgf room`: member mở control panel phòng của mình.

Bot không dùng control channel, payment channel hay system channel thay thế cho nhau. Payment panel chỉ đăng vào kênh đã chọn; panel phòng luôn nằm trong chat của chính voice room.

Member bình thường không cần slash command để tạo phòng; chỉ click voice trigger và dùng button panel.

## 2. Cấu hình Dashboard

Đăng nhập bằng Discord OAuth và chọn server mà bot đang hoạt động. Member thấy **Cửa hàng** và **Phòng đang mở** nhưng API chỉ trả các phòng member đó đang host. Account có `Administrator` hoặc là owner thấy toàn bộ Control Center và quản lý tất cả phòng trong server.

### Thành viên server

Admin có thể mở mục **Thành viên** để bot fetch toàn bộ member trong đúng server, bao gồm Discord ID, username, display name, avatar URL, role, trạng thái Premium và tổng các giao dịch đã thanh toán. Nếu chưa có giao dịch, dashboard hiển thị rõ chưa có thành viên nào mua Premium.

### Voice rooms

Vào Dashboard → **Voice rooms** → block **Setup voice creator**. Để trống Voice Channel ID để bot tự tạo trigger mới, hoặc nhập ID của một voice channel có sẵn để gắn làm trigger. Sau khi kích hoạt: member join trigger → bot tạo voice riêng → chuyển member sang phòng mới → ghi nhận member làm host.

Thêm nhiều creator channel:

| Field | Ý nghĩa |
|---|---|
| Channel ID | Voice channel member sẽ click để tạo phòng |
| Mode `basic` | Tạo phòng không có quyền chỉnh sửa, ngoài nút xóa |
| Mode `editable` | Tạo phòng có toàn bộ control; Free giữ 1 phòng/server, Premium không giới hạn |
| Category ID | Category riêng cho phòng đó; để trống dùng category mặc định |
| Allowed Role ID | Chỉ role này được tạo phòng; để trống thì mọi người đều được tạo |
| Log ra/vào | Giá trị mặc định cho thông báo người vào/rời trong chat voice room |
| Auto host | Tự chuyển ownership cho member còn lại khi host rời voice |

Cấu hình thêm:

- **Tên phòng template:** `{user}'s room`, hỗ trợ `{user}` và `{tag}`.
- **Payment panel channel:** kênh để `/sgf panel` đăng button mua/donate.
- **Premium role ID:** role được cấp kèm entitlement sau thanh toán; entitlement trong database mới là nguồn xác định thời hạn.
- **Panel phòng:** bot đăng trực tiếp vào chat của voice room, không nhảy sang control/payment/system channel khác.

Host và admin có thể đổi tên, limit, khóa/mở, ẩn/hiện, đặt password, mời, kick, chuyển host và bật/tắt log ra/vào. Discord không có password voice native nên bot sẽ disconnect người chưa được phép, gửi DM có nút nhập password, rồi cho họ vào lại sau khi nhập đúng.

Room không cấp `Manage Channels` cho member. Bot giữ quyền quản lý để member chỉ đổi được đúng phòng mình đang host; admin có thể quản lý tất cả phòng qua Discord hoặc Dashboard.

### Premium & giá

Tạo bao nhiêu gói tùy ý:

- Tên, mô tả, giá VND; gói tháng nên đặt `30` ngày.
- Role ID riêng; để trống vẫn kích hoạt entitlement Premium, hoặc dùng Premium role mặc định.
- Thanh toán gia hạn khi còn hạn sẽ cộng duration kể từ `expiresAt` hiện tại, không tính lại từ ngày thanh toán.
- Bot DM nhắc gia hạn một lần khi còn tối đa 3 ngày.
- Khi hết hạn, bot gỡ role và đóng các phòng editable vượt giới hạn, giữ phòng editable được tạo đầu tiên.
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

Cấu hình thêm SePay API v2 để đối soát khi webhook chậm hoặc thất bại:

```env
# Token tạo tại Company Settings → API Access. Không dùng token này làm webhook API key.
SEPAY_API_TOKEN=your_64_character_api_token
SEPAY_API_BASE_URL=https://userapi.sepay.vn/v2
```

Sandbox dùng `https://userapi-sandbox.sepay.vn/v2`. Biến cũ `SEPAY_ACCESS_TOKEN` vẫn được nhận làm alias, nhưng nên chuyển sang `SEPAY_API_TOKEN` cho đúng tên trong tài liệu SePay API v2.

Bot gọi API bằng `Authorization: Bearer ...` hoàn toàn ở backend. Khi checkout đang `pending`, hệ thống tìm giao dịch theo mã đơn, tiền vào tối thiểu, ngày tạo và số tài khoản; kết quả vẫn đi qua cùng cơ chế idempotency của webhook trước khi đánh dấu `paid`. Mỗi đơn chỉ đối soát tối đa một lần/15 giây và client API có hàng đợi để không vượt giới hạn 3 request/giây của SePay.

Webhook vẫn là luồng realtime được ưu tiên; API v2 là lớp kiểm tra/đối soát bổ sung. Admin có thể kiểm tra token và danh sách tài khoản đã liên kết trong Dashboard → **Tích hợp & nhận tiền**. Token không được trả về frontend hoặc ghi vào log.

Có thể dùng tài khoản cá nhân/doanh nghiệp theo khả năng tài khoản SePay của bạn. Đừng commit `.env`, webhook key hoặc API token.

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
| `GET` | `/api/guilds/:guildId/live-rooms` | host lấy phòng của mình; admin lấy toàn bộ phòng live |
| `POST` | `/api/guilds/:guildId/live-rooms/:channelId/action` | quản lý room: rename/limit/lock/hide/password/invite/kick/transfer/delete |
| `PUT` | `/api/guilds/:guildId/settings` | cấu hình từng creator và voice/payment |
| `POST/PUT/DELETE` | `/api/guilds/:guildId/products...` | bảng giá |
| `POST` | `/api/guilds/:guildId/payment-panel` | đăng button panel |
| `POST` | `/api/payments/sepay/webhook` | SePay gọi vào realtime |
| `GET` | `/api/guilds/:guildId/sepay-status` | admin kiểm tra kết nối API v2 và tài khoản đã liên kết |
| `GET` | `/api/public/payments/:paymentId` | đọc trạng thái và tự đối soát API v2 khi đơn còn pending |
| `GET` | `/api/integrations/sgf/payments` | SGF lấy donor/payment |
| `GET` | `/api/integrations/sgf/entitlements` | SGF lấy role entitlement |

## Production checklist

- [ ] `NODE_ENV=production`.
- [ ] `PUBLIC_URL` là HTTPS thật.
- [ ] OAuth redirect trên Discord khớp 100% với domain.
- [ ] `SESSION_SECRET`, `SEPAY_WEBHOOK_API_KEY`, `SEPAY_API_TOKEN`, `SGF_INTEGRATION_SECRET` nằm trong `.env`/secret manager và không bị commit.
- [ ] Reverse proxy chuyển HTTPS về port Node, websocket không bắt buộc.
- [ ] Volume persistent cho `data/sgf.sqlite` hoặc chuyển DB sang Postgres.
- [ ] Backup database; không expose file SQLite.
- [ ] Bot có role cao hơn Premium role nhưng thấp hơn role admin.
- [ ] Test SePay webhook trên staging trước khi bật auto cấp role.
