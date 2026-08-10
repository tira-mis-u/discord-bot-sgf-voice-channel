import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import express, { type NextFunction, type Request, type Response } from 'express';
import cookieParser from 'cookie-parser';
import cors from 'cors';
import { z } from 'zod';
import { config } from './config.js';
import { store } from './db.js';
import { SgfBot } from './bot.js';
import type { AuthSession, OAuthGuild, SessionUser } from './types.js';
import { clampText, escapeHtml, isDiscordAdmin, parseVnd } from './utils.js';
import { createDonationPayment, createProductPayment } from './services/payment-service.js';
import { verifySepayWebhook } from './services/sepay.js';

const publicDir = path.resolve('public');
const app = express();

app.use(cors({ origin: config.publicUrl, credentials: true }));
app.use(express.json({ limit: '256kb' }));
app.use(cookieParser());
app.use(express.static(publicDir, { index: false }));

interface AuthRequest extends Request {
  authSession?: AuthSession;
}

declare global {
  namespace Express {
    interface Request {
      authSession?: AuthSession;
    }
  }
}

function cookieOptions() {
  return { httpOnly: true, sameSite: 'lax' as const, secure: config.nodeEnv === 'production', maxAge: 1000 * 60 * 60 * 24 * 7, path: '/' };
}


async function refreshSession(session: AuthSession): Promise<AuthSession> {
  if (session.expiresAt > Date.now() + 60_000 || !session.refreshToken) return session;
  const response = await fetch('https://discord.com/api/v10/oauth2/token', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: config.discord.clientId,
      client_secret: config.discord.clientSecret,
      grant_type: 'refresh_token',
      refresh_token: session.refreshToken,
    }),
  });
  if (!response.ok) return session;
  const data = await response.json() as { access_token: string; refresh_token?: string; expires_in: number };
  return store.updateSession(session.id, { accessToken: data.access_token, refreshToken: data.refresh_token || session.refreshToken, expiresAt: Date.now() + data.expires_in * 1000 }) || session;
}

async function loadSession(req: AuthRequest, _res: Response, next: NextFunction): Promise<void> {
  try {
    const sessionId = req.cookies?.sgf_session;
    if (!sessionId) {
      next();
      return;
    }
    const session = store.getSession(sessionId);
    req.authSession = session ? await refreshSession(session) : undefined;
    next();
  } catch (error) {
    next(error);
  }
}
app.use(loadSession);

function requireAuth(req: AuthRequest, res: Response, next: NextFunction): void {
  if (!req.authSession) {
    res.status(401).json({ error: 'AUTH_REQUIRED', message: 'Đăng nhập Discord để tiếp tục.' });
    return;
  }
  next();
}

function sessionGuild(session: AuthSession | undefined, guildId: string): OAuthGuild | undefined {
  return session?.guilds.find((guild) => guild.id === guildId);
}

function canAccessGuild(req: AuthRequest, guildId: string): boolean {
  if (!req.authSession) return false;
  const guild = sessionGuild(req.authSession, guildId);
  const botAccess = bot.getGuildAccess(guildId);
  return Boolean(guild && botAccess.present && botAccess.administrator);
}

function canManageGuild(req: AuthRequest, guildId: string): boolean {
  if (!req.authSession) return false;
  const guild = sessionGuild(req.authSession, guildId);
  const botAccess = bot.getGuildAccess(guildId);
  return Boolean(guild && isDiscordAdmin(guild.permissions, guild.owner) && botAccess.present && botAccess.administrator);
}

function requireGuildAccess(req: AuthRequest, res: Response, guildId: string): boolean {
  if (!req.authSession) {
    res.status(401).json({ error: 'AUTH_REQUIRED', message: 'Đăng nhập Discord để tiếp tục.' });
    return false;
  }
  if (!canAccessGuild(req, guildId)) {
    res.status(403).json({ error: 'GUILD_ACCESS_REQUIRED', message: 'Server chưa sẵn sàng hoặc bạn không còn là thành viên của server.' });
    return false;
  }
  return true;
}

function requireGuildAdmin(req: AuthRequest, res: Response, guildId: string): boolean {
  if (!req.authSession) {
    res.status(401).json({ error: 'AUTH_REQUIRED', message: 'Đăng nhập Discord để tiếp tục.' });
    return false;
  }
  if (!canManageGuild(req, guildId)) {
    res.status(403).json({ error: 'ADMIN_REQUIRED', message: 'Bạn phải là owner hoặc Administrator của server.' });
    return false;
  }
  return true;
}

function requireSgfIntegration(req: Request, res: Response): boolean {
  const supplied = String(req.headers['x-sgf-secret'] || req.headers.authorization || '').replace(/^Bearer\s+/i, '');
  if (!config.sgf.integrationSecret || supplied !== config.sgf.integrationSecret) {
    res.status(401).json({ error: 'INTEGRATION_UNAUTHORIZED' });
    return false;
  }
  return true;
}

function safeReturnTo(value: unknown): string {
  const candidate = String(value || '/');
  return candidate.startsWith('/') && !candidate.startsWith('//') ? candidate : '/';
}

async function discordApi<T>(endpoint: string, accessToken: string): Promise<T> {
  const response = await fetch(`https://discord.com/api/v10${endpoint}`, { headers: { authorization: `Bearer ${accessToken}` } });
  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Discord API ${response.status} ${endpoint}: ${body}`);
  }
  return response.json() as Promise<T>;
}

app.get('/auth/discord', (req: Request, res: Response) => {
  if (!config.discord.clientId || !config.discord.clientSecret) {
    res.status(503).send('Discord OAuth chưa được cấu hình.');
    return;
  }
  const state = crypto.randomBytes(24).toString('hex');
  res.cookie('oauth_state', state, cookieOptions());
  res.cookie('oauth_return', safeReturnTo(req.query.returnTo), cookieOptions());
  const params = new URLSearchParams({ client_id: config.discord.clientId, redirect_uri: config.discord.redirectUri, response_type: 'code', scope: 'identify guilds', state });
  res.redirect(`https://discord.com/oauth2/authorize?${params.toString()}`);
});

app.get('/auth/discord/callback', async (req: Request, res: Response) => {
  const state = String(req.query.state || '');
  const expectedState = String(req.cookies?.oauth_state || '');
  const returnTo = safeReturnTo(req.cookies?.oauth_return);
  if (!state || !expectedState || state !== expectedState) {
    res.status(400).send('OAuth state không hợp lệ. Hãy thử đăng nhập lại.');
    return;
  }
  try {
    const code = String(req.query.code || '');
    if (!code) {
      res.status(400).send('Discord không trả về OAuth code. Hãy bấm đăng nhập lại.');
      return;
    }
    console.log(`[oauth] exchanging code: client=${config.discord.clientId}, redirect=${config.discord.redirectUri}, codeLength=${code.length}`);
    const tokenResponse = await fetch('https://discord.com/api/v10/oauth2/token', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ client_id: config.discord.clientId, client_secret: config.discord.clientSecret, grant_type: 'authorization_code', code, redirect_uri: config.discord.redirectUri }),
    });
    const tokenBody = await tokenResponse.text();
    if (!tokenResponse.ok) {
      let detail = tokenBody;
      try {
        const parsed = JSON.parse(tokenBody) as { error?: string; error_description?: string };
        detail = [parsed.error, parsed.error_description].filter(Boolean).join(': ') || tokenBody;
      } catch {
        // Keep the raw body for Discord proxy/errors that are not JSON.
      }
      console.error('[oauth] Discord token exchange failed', { status: tokenResponse.status, detail, clientId: config.discord.clientId, redirectUri: config.discord.redirectUri });
      throw new Error(`Discord token exchange ${tokenResponse.status}: ${detail || 'unknown_error'}`);
    }
    const token = JSON.parse(tokenBody) as { access_token: string; refresh_token: string; expires_in: number };
    const user = await discordApi<{ id: string; username: string; global_name?: string; avatar?: string }>('/users/@me', token.access_token);
    const guilds = await discordApi<OAuthGuild[]>('/users/@me/guilds', token.access_token);
    const session = store.createSession({ user: { id: user.id, username: user.username, globalName: user.global_name, avatar: user.avatar }, accessToken: token.access_token, refreshToken: token.refresh_token, expiresAt: Date.now() + token.expires_in * 1000, guilds });
    res.cookie('sgf_session', session.id, cookieOptions());
    res.clearCookie('oauth_state');
    res.clearCookie('oauth_return');
    res.redirect(returnTo);
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown OAuth error';
    console.error('[oauth]', error);
    res.status(502).send(`<!doctype html><meta charset="utf-8"><title>Discord OAuth error</title><style>body{font-family:system-ui;background:#0b0c12;color:#f5f3ff;padding:40px;line-height:1.6}main{max-width:720px;margin:auto;background:#171923;border:1px solid #303449;border-radius:14px;padding:28px}code{color:#c4b5fd;word-break:break-word}</style><main><h1>Đăng nhập Discord thất bại</h1><p>OAuth code không đổi được thành access token.</p><p><code>${escapeHtml(message)}</code></p><p>Kiểm tra lại Client Secret, redirect URI và đừng refresh lại callback URL. Xem terminal để biết Discord trả về lỗi gì.</p></main>`);
  }
});

app.post('/auth/logout', (req: AuthRequest, res: Response) => {
  if (req.authSession) store.deleteSession(req.authSession.id);
  res.clearCookie('sgf_session');
  res.json({ ok: true });
});

app.get('/api/health', (_req, res) => res.json({ ok: true, service: 'sgf-discord-bot', time: new Date().toISOString() }));

app.get('/api/runtime', (_req, res) => {
  const permissions = 288377872;
  const inviteUrl = config.discord.clientId
    ? `https://discord.com/oauth2/authorize?client_id=${encodeURIComponent(config.discord.clientId)}&scope=bot%20applications.commands&permissions=${permissions}`
    : '';
  res.json({
    ...bot.getRuntimeStatus(),
    publicUrl: config.publicUrl,
    sepayWebhookUrl: `${config.publicUrl}/api/payments/sepay/webhook`,
    inviteUrl,
  });
});

app.get('/api/session', (req: AuthRequest, res: Response) => {
  res.json({ authenticated: Boolean(req.authSession), user: req.authSession?.user || null });
});

app.get('/api/guilds', requireAuth, (req: AuthRequest, res: Response) => {
  const guilds = (req.authSession?.guilds || [])
    .map((guild) => ({ ...guild, canManage: isDiscordAdmin(guild.permissions, guild.owner), bot: bot.getGuildAccess(guild.id), settings: store.getSettings(guild.id, guild.name) }))
    .filter((guild) => guild.bot.present && guild.bot.administrator);
  res.json({ guilds });
});

app.get('/api/guilds/:guildId', requireAuth, (req: AuthRequest, res: Response) => {
  const guildId = String(req.params.guildId);
  if (!requireGuildAccess(req, res, guildId)) return;
  const guild = sessionGuild(req.authSession, guildId);
  const settings = store.getSettings(guildId, guild?.name || '');
  const canManage = canManageGuild(req, guildId);
  res.json({
    guild: guild || { id: guildId, name: settings.guildName },
    canManage,
    bot: bot.getGuildAccess(guildId),
    settings,
    products: store.listProducts(guildId, !canManage),
    stats: canManage ? store.getStats(guildId) : { paidTotalVnd: 0, paidCount: 0, pendingCount: 0, donorCount: 0, activeRooms: 0 },
    rooms: canManage ? store.listRooms(guildId) : [],
    sepay: { webhookConfigured: Boolean(config.sepay.webhookApiKey), dynamicQrConfigured: Boolean(settings.bankCode || config.sepay.bankCode) && Boolean(settings.bankAccountNumber || config.sepay.accountNumber), staticQrConfigured: Boolean(settings.staticQrUrl || config.sepay.staticQrUrl), webhookUrl: `${config.publicUrl}/api/payments/sepay/webhook` },
    integration: { paymentsEndpoint: `${config.publicUrl}/api/integrations/sgf/payments`, entitlementsEndpoint: `${config.publicUrl}/api/integrations/sgf/entitlements`, eventsConfigured: Boolean(config.sgf.eventsWebhookUrl) },
  });
});

const settingsInput = z.object({
  guildName: z.string().max(100).optional(),
  creatorChannels: z.array(z.object({ channelId: z.string().min(1).max(32), label: z.string().max(80), mode: z.enum(['free', 'premium']), categoryId: z.string().max(32).optional() })).max(30).optional(),
  premiumRoleId: z.string().max(32).optional(),
  controlChannelId: z.string().max(32).optional(),
  paymentPanelChannelId: z.string().max(32).optional(),
  defaultRoomCategoryId: z.string().max(32).optional(),
  roomNameTemplate: z.string().max(100).optional(),
  donationMinVnd: z.number().int().min(1000).max(500000000).optional(),
  bankCode: z.string().max(30).optional(),
  bankAccountNumber: z.string().max(40).optional(),
  bankAccountName: z.string().max(100).optional(),
  staticQrUrl: z.string().max(1000).optional(),
});

app.post('/api/guilds/:guildId/creator-channels', requireAuth, async (req: AuthRequest, res: Response) => {
  const guildId = String(req.params.guildId);
  if (!requireGuildAdmin(req, res, guildId)) return;
  const input = z.object({ label: z.string().min(1).max(100), mode: z.enum(['free', 'premium']), categoryId: z.string().max(32).optional() }).safeParse(req.body);
  if (!input.success) {
    res.status(400).json({ error: 'INVALID_CREATOR_CHANNEL', details: input.error.flatten() });
    return;
  }
  const discordGuild = bot.client.guilds.cache.get(guildId);
  if (!discordGuild) {
    res.status(409).json({ error: 'BOT_NOT_IN_GUILD', message: 'Bot chưa ở trong server này.' });
    return;
  }
  try {
    const creator = await bot.createCreatorChannel(discordGuild, input.data);
    res.status(201).json({ creator, settings: store.getSettings(guildId, discordGuild.name) });
  } catch (error) {
    res.status(400).json({ error: error instanceof Error ? error.message : 'Không tạo được creator channel.' });
  }
});

app.put('/api/guilds/:guildId/settings', requireAuth, (req: AuthRequest, res: Response) => {
  const guildId = String(req.params.guildId);
  if (!requireGuildAdmin(req, res, guildId)) return;
  const parsed = settingsInput.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'INVALID_SETTINGS', details: parsed.error.flatten() });
    return;
  }
  const guild = sessionGuild(req.authSession, guildId);
  const patch = { ...parsed.data, ...(guild?.name ? { guildName: guild.name } : {}) };
  const settings = store.updateSettings(guildId, patch);
  res.json({ settings });
});

const productInput = z.object({
  name: z.string().min(1).max(80),
  description: z.string().max(300).default(''),
  priceVnd: z.number().int().min(1000).max(500000000),
  roleId: z.string().max(32).default(''),
  durationDays: z.number().int().min(0).max(3650).default(30),
  active: z.boolean().default(true),
  sortOrder: z.number().int().min(0).max(999).default(0),
});

app.post('/api/guilds/:guildId/products', requireAuth, (req: AuthRequest, res: Response) => {
  const guildId = String(req.params.guildId);
  if (!requireGuildAdmin(req, res, guildId)) return;
  const parsed = productInput.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'INVALID_PRODUCT', details: parsed.error.flatten() });
    return;
  }
  const product = store.createProduct({ guildId, ...parsed.data });
  res.status(201).json({ product });
});

app.put('/api/guilds/:guildId/products/:productId', requireAuth, (req: AuthRequest, res: Response) => {
  const guildId = String(req.params.guildId);
  const productId = String(req.params.productId);
  if (!requireGuildAdmin(req, res, guildId)) return;
  const existing = store.getProduct(productId);
  if (!existing || existing.guildId !== guildId) {
    res.status(404).json({ error: 'PRODUCT_NOT_FOUND' });
    return;
  }
  const parsed = productInput.partial().safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'INVALID_PRODUCT', details: parsed.error.flatten() });
    return;
  }
  res.json({ product: store.updateProduct(productId, parsed.data) });
});

app.delete('/api/guilds/:guildId/products/:productId', requireAuth, (req: AuthRequest, res: Response) => {
  const guildId = String(req.params.guildId);
  const productId = String(req.params.productId);
  if (!requireGuildAdmin(req, res, guildId)) return;
  const existing = store.getProduct(productId);
  if (!existing || existing.guildId !== guildId) {
    res.status(404).json({ error: 'PRODUCT_NOT_FOUND' });
    return;
  }
  store.deleteProduct(productId);
  res.json({ ok: true });
});

app.get('/api/guilds/:guildId/payments', requireAuth, (req: AuthRequest, res: Response) => {
  const guildId = String(req.params.guildId);
  if (!requireGuildAdmin(req, res, guildId)) return;
  const limit = Math.min(500, Math.max(1, Number(req.query.limit || 100)));
  res.json({ payments: store.listPayments(guildId, Number.isFinite(limit) ? limit : 100) });
});

app.get('/api/guilds/:guildId/rooms', requireAuth, (req: AuthRequest, res: Response) => {
  const guildId = String(req.params.guildId);
  if (!requireGuildAdmin(req, res, guildId)) return;
  res.json({ rooms: store.listRooms(guildId) });
});

app.get('/api/guilds/:guildId/members', requireAuth, async (req: AuthRequest, res: Response) => {
  const guildId = String(req.params.guildId);
  if (!requireGuildAdmin(req, res, guildId)) return;
  try {
    const settings = store.getSettings(guildId);
    const paidSummary = store.getPaidUserSummary(guildId);
    const entitlements = store.listEntitlements(guildId);
    const activeByUser = new Set(entitlements.filter((item) => item.status === 'active').map((item) => item.discordUserId));
    const members = await bot.listGuildMembers(guildId);
    res.json({
      members: members.map((member) => {
        const payment = paidSummary[member.id] || { paidCount: 0, paidTotalVnd: 0, lastPaidAt: '' };
        const premium = activeByUser.has(member.id) || Boolean(settings.premiumRoleId && member.roleIds.includes(settings.premiumRoleId));
        return { ...member, premium, paid: payment.paidCount > 0, payment };
      }),
    });
  } catch (error) {
    res.status(502).json({ error: error instanceof Error ? error.message : 'Không fetch được thành viên server.' });
  }
});

app.post('/api/guilds/:guildId/payment-panel', requireAuth, async (req: AuthRequest, res: Response) => {
  const guildId = String(req.params.guildId);
  if (!requireGuildAdmin(req, res, guildId)) return;
  const guild = (req.authSession?.guilds || []).find((item) => item.id === guildId);
  const discordGuild = bot.client.guilds.cache.get(guildId);
  if (!discordGuild) {
    res.status(409).json({ error: 'BOT_NOT_IN_GUILD', message: 'Bot chưa ở trong server này.' });
    return;
  }
  const result = await bot.postPaymentPanel(discordGuild, store.getSettings(guildId, guild?.name || ''));
  res.json({ ok: true, message: result });
});

app.get('/api/public/guilds/:guildId/products', (req: Request, res: Response) => {
  const products = store.listProducts(String(req.params.guildId), true).map(({ id, guildId, name, description, priceVnd, durationDays }) => ({ id, guildId, name, description, priceVnd, durationDays }));
  res.json({ products, settings: { donationMinVnd: store.getSettings(String(req.params.guildId)).donationMinVnd } });
});

app.post('/api/public/guilds/:guildId/payment', requireAuth, (req: AuthRequest, res: Response) => {
  const guildId = String(req.params.guildId);
  if (!canAccessGuild(req, guildId)) {
    res.status(403).json({ error: 'GUILD_ACCESS_REQUIRED', message: 'Bạn phải là thành viên của server để mua gói.' });
    return;
  }
  const productId = String(req.body?.productId || '');
  try {
    const user = req.authSession!.user;
    const result = createProductPayment({ guildId, userId: user.id, userTag: user.username, productId });
    res.status(201).json({ ...result, payment: { ...result.payment, qrUrl: result.payment.qrUrl, checkoutUrl: result.payment.checkoutUrl } });
  } catch (error) {
    res.status(400).json({ error: error instanceof Error ? error.message : 'Không tạo được đơn.' });
  }
});

app.post('/api/public/guilds/:guildId/donation', requireAuth, (req: AuthRequest, res: Response) => {
  const guildId = String(req.params.guildId);
  if (!canAccessGuild(req, guildId)) {
    res.status(403).json({ error: 'GUILD_ACCESS_REQUIRED', message: 'Bạn phải là thành viên của server để donate.' });
    return;
  }
  try {
    const user = req.authSession!.user;
    const result = createDonationPayment({ guildId, userId: user.id, userTag: user.username, amountVnd: parseVnd(req.body?.amountVnd), note: clampText(req.body?.note, 200) });
    res.status(201).json({ ...result, payment: { ...result.payment, qrUrl: result.payment.qrUrl, checkoutUrl: result.payment.checkoutUrl } });
  } catch (error) {
    res.status(400).json({ error: error instanceof Error ? error.message : 'Không tạo được đơn.' });
  }
});

app.get('/api/public/payments/:paymentId', requireAuth, (req: AuthRequest, res: Response) => {
  const payment = store.getPayment(String(req.params.paymentId));
  if (!payment) {
    res.status(404).json({ error: 'PAYMENT_NOT_FOUND' });
    return;
  }
  const admin = canManageGuild(req, payment.guildId);
  const owner = payment.discordUserId === req.authSession!.user.id;
  if (!admin && !owner) {
    res.status(403).json({ error: 'PAYMENT_FORBIDDEN' });
    return;
  }
  const settings = store.getSettings(payment.guildId);
  res.json({ payment, product: payment.productId ? store.getProduct(payment.productId) : undefined, paymentInfo: { bankCode: settings.bankCode || config.sepay.bankCode, accountNumber: settings.bankAccountNumber || config.sepay.accountNumber, accountName: settings.bankAccountName || config.sepay.accountName } });
});

app.post('/api/payments/sepay/webhook', async (req: Request, res: Response) => {
  if (!verifySepayWebhook(req.headers as Record<string, unknown>)) {
    res.status(401).json({ success: false, message: 'Unauthorized' });
    return;
  }
  try {
    const result = await bot.handleSepayWebhook(req.body);
    res.status(200).json({ success: result.ok, matched: result.matched, message: result.message });
  } catch (error) {
    console.error('[sepay webhook]', error);
    res.status(500).json({ success: false, message: 'Webhook processing failed' });
  }
});

app.get('/api/integrations/sgf/payments', (req: Request, res: Response) => {
  if (!requireSgfIntegration(req, res)) return;
  const guildId = String(req.query.guildId || '');
  if (!guildId) {
    res.status(400).json({ error: 'guildId is required' });
    return;
  }
  const limit = Math.min(500, Math.max(1, Number(req.query.limit || 100)));
  res.json({ data: store.listPayments(guildId, Number.isFinite(limit) ? limit : 100) });
});

app.get('/api/integrations/sgf/entitlements', (req: Request, res: Response) => {
  if (!requireSgfIntegration(req, res)) return;
  const guildId = String(req.query.guildId || '');
  if (!guildId) {
    res.status(400).json({ error: 'guildId is required' });
    return;
  }
  res.json({ data: store.listEntitlements(guildId, String(req.query.discordUserId || '') || undefined) });
});

app.get('/', (_req, res) => res.sendFile(path.join(publicDir, 'dashboard.html')));
app.get('/dashboard', (_req, res) => res.sendFile(path.join(publicDir, 'dashboard.html')));
app.get('/checkout/payment/:paymentId', (_req, res) => res.sendFile(path.join(publicDir, 'checkout.html')));

app.use((error: unknown, _req: Request, res: Response, _next: NextFunction) => {
  console.error('[server]', error);
  res.status(500).json({ error: 'INTERNAL_ERROR' });
});

export function createServer(botInstance: SgfBot): express.Express {
  bot = botInstance;
  return app;
}

let bot: SgfBot;

export async function startServer(botInstance: SgfBot): Promise<void> {
  createServer(botInstance);
  await new Promise<void>((resolve) => {
    app.listen(config.port, '0.0.0.0', () => {
      console.log(`[web] dashboard listening on ${config.publicUrl} (port ${config.port})`);
      resolve();
    });
  });
}
