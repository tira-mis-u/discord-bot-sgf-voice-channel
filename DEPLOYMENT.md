# Deploy lên domain SGF

Có thể chạy bot và dashboard dưới subdomain, ví dụ `bot.sgf.vn`. Domain SGF chính chỉ cần gọi read API bằng server-to-server secret.

## Không deploy toàn bộ Discord bot lên Vercel

Vercel Functions có filesystem read-only và chỉ cho ghi tạm vào `/tmp`. Code tự chuyển SQLite sang `/tmp` khi phát hiện `VERCEL=1` để tránh lỗi `mkdir '/var/task/data'`, nhưng database này là **ephemeral** và có thể mất giữa các invocation.

Quan trọng hơn, Discord Gateway cần một process chạy liên tục. Vercel Functions là stateless và có thời gian chạy giới hạn, nên không phù hợp để giữ bot online, nhận voice-state events hoặc chạy maintenance timer.

Kiến trúc production đề xuất:

- chạy bot + Express API trên Railway, Render, Fly.io, VPS hoặc container luôn bật;
- dùng Supabase PostgreSQL làm database persistent sau khi hoàn tất migration;
- Vercel chỉ dùng cho frontend tĩnh nếu muốn, và frontend gọi backend bot qua HTTPS.

Không sử dụng SQLite `/tmp` cho payment, entitlement, OAuth session hoặc cấu hình server production.

## Option A: Docker Compose

### `docker-compose.yml`

```yaml
services:
  sgf-bot:
    build: .
    restart: unless-stopped
    env_file: .env
    ports:
      - "3000:3000"
    volumes:
      - ./data:/app/data
```

```bash
cp .env.example .env
# sửa .env: PUBLIC_URL=https://bot.sgf.vn, NODE_ENV=production
npm install
# build image và chạy
docker compose up -d --build
```

Đảm bảo `./data` nằm trên disk persistent. Không mount `.env` ra public.

## Option B: Node + systemd

```bash
npm ci
npm run build
NODE_ENV=production node dist/index.js
```

Ví dụ systemd `/etc/systemd/system/sgf-bot.service`:

```ini
[Unit]
Description=SGF Discord Bot
After=network.target

[Service]
Type=simple
WorkingDirectory=/opt/sgf-discord-bot
EnvironmentFile=/opt/sgf-discord-bot/.env
ExecStart=/usr/bin/node dist/index.js
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now sgf-bot
sudo journalctl -u sgf-bot -f
```

## Nginx reverse proxy

```nginx
server {
    listen 443 ssl http2;
    server_name bot.sgf.vn;

    # certbot sẽ thêm ssl_certificate ở đây

    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}
```

Sau đó cập nhật:

```env
PUBLIC_URL=https://bot.sgf.vn
DISCORD_REDIRECT_URI=https://bot.sgf.vn/auth/discord/callback
```

Trong Discord Developer Portal, thêm đúng redirect URI HTTPS đó.

## SePay production setup

1. Mở Dashboard → tab **Tích hợp SGF** copy webhook URL.
2. Vào SePay → Webhooks → tạo webhook mới.
3. Chọn bank account dùng để nhận tiền.
4. Chọn `In_only`, JSON request, API key auth.
5. Paste webhook API key vào `SEPAY_WEBHOOK_API_KEY` trong `.env`.
6. Vào Company Settings → API Access, tạo API v2 token rồi lưu vào `SEPAY_API_TOKEN`.
7. Dùng `SEPAY_API_BASE_URL=https://userapi.sepay.vn/v2` cho production hoặc `https://userapi-sandbox.sepay.vn/v2` cho test mode.
8. Restart service, vào Dashboard → **Tích hợp & nhận tiền** → **Kiểm tra API v2**.
9. Dùng payment panel tạo một đơn nhỏ; chuyển đúng mã; kiểm tra webhook/API reconciliation + role + ledger.

Webhook endpoint phải public HTTPS và trả HTTP 2xx nhanh. Webhook xử lý realtime; SePay API v2 dùng Bearer token để đối soát đơn pending khi webhook chậm. Code chống transaction trùng và lưu unmatched transaction để debug. Không expose API token cho frontend.

## Dùng domain SGF chính

Backend của SGF gọi:

```bash
curl -H "X-SGF-Secret: $SGF_BOT_API_SECRET" \
  "https://bot.sgf.vn/api/integrations/sgf/payments?guildId=1234567890&limit=100"
```

Không đưa `SGF_INTEGRATION_SECRET` vào JavaScript frontend. Nếu frontend cần dashboard riêng, SGF backend proxy dữ liệu hoặc tạo endpoint riêng có auth của SGF.

## Database

Starter dùng SQLite để cài nhanh. Khi chạy nhiều bot/server hoặc nhiều worker:

- dùng một process bot chính để xử lý Discord gateway;
- chuyển store sang PostgreSQL/Prisma hoặc Drizzle;
- đặt job expiry entitlement và cleanup giao dịch unmatched;
- encrypt OAuth refresh token at rest hoặc dùng secret store.
