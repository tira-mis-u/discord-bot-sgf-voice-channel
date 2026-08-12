import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import express, { type NextFunction, type Request, type Response } from 'express';
import cookieParser from 'cookie-parser';
import cors from 'cors';
import { z } from 'zod';
import { ChannelType } from 'discord.js';
import { config } from './config.js';
import { databaseBackend, store } from './db.js';
import { cache } from './cache.js';
import { SgfBot } from './bot.js';
import type { AuthSession, OAuthGuild, SessionUser } from './types.js';
import { clampText, escapeHtml, isDiscordAdmin, parseVnd } from './utils.js';
import { createDonationPayment, createProductPayment, reconcilePendingPayment } from './services/payment-service.js';
import { verifySepayWebhook } from './services/sepay.js';
import { getSepayApiStatus, isSepayApiConfigured } from './services/sepay-api.js';
import { sessionStore } from './services/session-store.js';

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
  return await sessionStore.update(session.id, { accessToken: data.access_token, refreshToken: data.refresh_token || session.refreshToken, expiresAt: Date.now() + data.expires_in * 1000 }) || session;
}

async function loadSession(req: AuthRequest, _res: Response, next: NextFunction): Promise<void> {
  try {
    const sessionId = req.cookies?.sgf_session;
    if (!sessionId) {
      next();
      return;
    }
    const session = await sessionStore.get(sessionId);
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

function isDeveloper(session: AuthSession | undefined): boolean {
  return Boolean(session?.user.id && config.developerIds.includes(session.user.id));
}

function canAccessGuild(req: AuthRequest, guildId: string): boolean {
  if (!req.authSession) return false;
  const botAccess = bot.getGuildAccess(guildId);
  if (isDeveloper(req.authSession)) return botAccess.present && botAccess.administrator;
  const guild = sessionGuild(req.authSession, guildId);
  return Boolean(guild && botAccess.present && botAccess.administrator);
}

function canManageGuild(req: AuthRequest, guildId: string): boolean {
  if (!req.authSession) return false;
  const botAccess = bot.getGuildAccess(guildId);
  if (isDeveloper(req.authSession)) return botAccess.present && botAccess.administrator;
  const guild = sessionGuild(req.authSession, guildId);
  return Boolean(guild && isDiscordAdmin(guild.permissions, guild.owner) && botAccess.present && botAccess.administrator);
}

function canManageMoney(req: AuthRequest): boolean {
  return isDeveloper(req.authSession);
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

function requireDeveloper(req: AuthRequest, res: Response): boolean {
  if (!req.authSession) {
    res.status(401).json({ error: 'AUTH_REQUIRED', message: 'Đăng nhập Discord để tiếp tục.' });
    return false;
  }
  if (!isDeveloper(req.authSession)) {
    res.status(403).json({ error: 'DEVELOPER_REQUIRED', message: 'Mục này chỉ dành cho Study Voice developers.' });
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

app.get('/auth/discord', async (req: Request, res: Response) => {
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
    const session = await sessionStore.create({ user: { id: user.id, username: user.username, globalName: user.global_name, avatar: user.avatar }, accessToken: token.access_token, refreshToken: token.refresh_token, expiresAt: Date.now() + token.expires_in * 1000, guilds });
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

app.post('/auth/logout', async (req: AuthRequest, res: Response) => {
  if (req.authSession) await sessionStore.delete(req.authSession.id);
  res.clearCookie('sgf_session');
  res.json({ ok: true });
});

app.get('/api/health', async (_req, res) => res.json({
  ok: true,
  service: 'sgf-discord-bot',
  databaseBackend,
  databasePersistence: databaseBackend === 'postgresql' ? 'persistent' : config.databasePersistence,
  postgresConfigured: Boolean(config.databaseUrl),
  cacheBackend: cache.backend,
  cacheReachable: await cache.ping(),
  redisConfigured: Boolean(config.redis.url || (config.redis.upstashRestUrl && config.redis.upstashRestToken)),
  vercel: config.isVercel,
  time: new Date().toISOString(),
}));

app.get('/api/runtime', (_req, res) => {
  const permissions = 288377872;
  const inviteUrl = config.discord.clientId
    ? `https://discord.com/oauth2/authorize?client_id=${encodeURIComponent(config.discord.clientId)}&scope=bot%20applications.commands&permissions=${permissions}`
    : '';
  res.json({
    ...bot.getRuntimeStatus(),
    publicUrl: config.publicUrl,
    sepayWebhookUrl: `${config.publicUrl}/api/payments/sepay/webhook`,
    sepayWebhookConfigured: Boolean(config.sepay.webhookApiKey),
    sepayApiConfigured: isSepayApiConfigured(),
    inviteUrl,
  });
});

app.get('/api/session', async (req: AuthRequest, res: Response) => {
  res.json({ authenticated: Boolean(req.authSession), user: req.authSession?.user || null, isDeveloper: isDeveloper(req.authSession) });
});

app.get('/api/guilds', requireAuth, async (req: AuthRequest, res: Response) => {
  const developer = isDeveloper(req.authSession);
  const sourceGuilds: OAuthGuild[] = developer
    ? bot.listConnectedGuilds().map((guild) => ({ id: guild.id, name: guild.name, icon: guild.icon, owner: true, permissions: '8' }))
    : req.authSession?.guilds || [];
  const guilds = (await Promise.all(sourceGuilds.map(async (guild) => ({
    ...guild,
    canManage: developer || isDiscordAdmin(guild.permissions, guild.owner),
    canManageMoney: developer,
    isDeveloper: developer,
    bot: bot.getGuildAccess(guild.id),
    settings: await store.getSettings(guild.id, guild.name),
  })))).filter((guild) => guild.bot.present && guild.bot.administrator);
  res.json({ guilds, isDeveloper: developer });
});

app.get('/api/developer/system', requireAuth, async (req: AuthRequest, res: Response) => {
  if (!requireDeveloper(req, res)) return;
  const connectedGuilds = bot.listConnectedGuilds();
  const [stats, payments, guilds] = await Promise.all([
    store.getGlobalStats(),
    store.listAllPayments(Math.min(500, Math.max(1, Number(req.query.limit || 100)))),
    Promise.all(connectedGuilds.map(async (guild) => ({ ...guild, stats: await store.getStats(guild.id) }))),
  ]);
  res.json({ stats: { ...stats, guildCount: connectedGuilds.length }, payments, guilds });
});

app.post('/api/developer/guilds/:guildId/premium', requireAuth, async (req: AuthRequest, res: Response) => {
  if (!requireDeveloper(req, res)) return;
  const parsed = z.object({
    userId: z.string().min(1).max(32),
    action: z.enum(['grant', 'extend', 'revoke']),
    days: z.number().int().min(0).max(3650).default(30),
    note: z.string().max(200).optional(),
  }).safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'INVALID_PREMIUM_ACTION', details: parsed.error.flatten() });
    return;
  }
  try {
    const result = await bot.manageManualPremium({ guildId: String(req.params.guildId), developerId: req.authSession!.user.id, ...parsed.data });
    res.json({ ok: true, ...result });
  } catch (error) {
    res.status(400).json({ error: error instanceof Error ? error.message : 'Không cập nhật được Premium.' });
  }
});

app.get('/api/guilds/:guildId', requireAuth, async (req: AuthRequest, res: Response) => {
  const guildId = String(req.params.guildId);
  if (!requireGuildAccess(req, res, guildId)) return;
  const guild = sessionGuild(req.authSession, guildId);
  const settings = await store.getSettings(guildId, guild?.name || '');
  const canManage = canManageGuild(req, guildId);
  const developer = isDeveloper(req.authSession);
  const entitlement = req.authSession ? await store.getEntitlement(guildId, req.authSession.user.id) : undefined;
  const roomRows = canManage ? await store.listRooms(guildId) : [];
  const rooms = roomRows.map(({ passwordHash, passwordSalt: _passwordSalt, ...room }) => ({ ...room, passwordEnabled: Boolean(passwordHash) }));
  const stats = developer
    ? await store.getStats(guildId)
    : { paidTotalVnd: 0, paidCount: 0, pendingCount: 0, donorCount: 0, activeRooms: roomRows.length };
  const visibleSettings = developer ? settings : {
    ...settings,
    paymentPanelChannelId: '',
    bankCode: '',
    bankAccountNumber: '',
    bankAccountName: '',
    staticQrUrl: '',
  };
  res.json({
    guild: guild || { id: guildId, name: settings.guildName },
    canManage,
    canManageMoney: developer,
    isDeveloper: developer,
    bot: bot.getGuildAccess(guildId),
    subscription: { premium: developer || Boolean(entitlement), founder: developer, expiresAt: developer ? '' : entitlement?.expiresAt || '', freeEditableLimit: 1 },
    settings: visibleSettings,
    products: await store.listProducts(guildId, !developer),
    stats,
    rooms,
    sepay: developer ? { webhookConfigured: Boolean(config.sepay.webhookApiKey), apiTokenConfigured: isSepayApiConfigured(), apiBaseUrl: config.sepay.apiBaseUrl, dynamicQrConfigured: Boolean(settings.bankCode || config.sepay.bankCode) && Boolean(settings.bankAccountNumber || config.sepay.accountNumber), staticQrConfigured: Boolean(settings.staticQrUrl || config.sepay.staticQrUrl), webhookUrl: `${config.publicUrl}/api/payments/sepay/webhook` } : { webhookConfigured: false, apiTokenConfigured: false, apiBaseUrl: '', dynamicQrConfigured: false, staticQrConfigured: false, webhookUrl: '' },
    integration: developer ? { paymentsEndpoint: `${config.publicUrl}/api/integrations/sgf/payments`, entitlementsEndpoint: `${config.publicUrl}/api/integrations/sgf/entitlements`, eventsConfigured: Boolean(config.sgf.eventsWebhookUrl) } : { paymentsEndpoint: '', entitlementsEndpoint: '', eventsConfigured: false },
  });
});

const creatorModeInput = z.enum(['basic', 'editable', 'free', 'premium']).transform((value) => value === 'editable' || value === 'premium' ? 'editable' as const : 'basic' as const);

const creatorChannelInput = z.object({
  channelId: z.string().min(1).max(32),
  label: z.string().max(100),
  mode: creatorModeInput,
  categoryId: z.string().max(32).optional(),
  allowedRoleId: z.string().max(32).optional(),
  notifyJoinLeave: z.boolean().optional().default(false),
  autoTransferOwner: z.boolean().optional().default(true),
});

const settingsInput = z.object({
  guildName: z.string().max(100).optional(),
  creatorChannels: z.array(creatorChannelInput).max(30).optional(),
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
  const input = z.object({
    label: z.string().min(1).max(100),
    mode: creatorModeInput,
    categoryId: z.string().max(32).optional(),
    allowedRoleId: z.string().max(32).optional(),
    notifyJoinLeave: z.boolean().optional().default(false),
    autoTransferOwner: z.boolean().optional().default(true),
  }).safeParse(req.body);
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
    res.status(201).json({ creator, settings: await store.getSettings(guildId, discordGuild.name) });
  } catch (error) {
    res.status(400).json({ error: error instanceof Error ? error.message : 'Không tạo được creator channel.' });
  }
});

app.put('/api/guilds/:guildId/settings', requireAuth, async (req: AuthRequest, res: Response) => {
  const guildId = String(req.params.guildId);
  if (!requireGuildAdmin(req, res, guildId)) return;
  const parsed = settingsInput.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'INVALID_SETTINGS', details: parsed.error.flatten() });
    return;
  }
  const discordGuild = bot.client.guilds.cache.get(guildId);
  if (parsed.data.creatorChannels && discordGuild) {
    const channelIds = new Set<string>();
    for (const creator of parsed.data.creatorChannels) {
      const channel = discordGuild.channels.cache.get(creator.channelId);
      if (!channel || channel.type !== ChannelType.GuildVoice) {
        res.status(400).json({ error: 'INVALID_CREATOR_CHANNEL', message: `Channel ID ${creator.channelId} không phải voice channel hoặc bot không nhìn thấy.` });
        return;
      }
      if (channelIds.has(creator.channelId)) {
        res.status(400).json({ error: 'DUPLICATE_CREATOR_CHANNEL', message: `Voice channel ${creator.channelId} đang bị khai báo trùng.` });
        return;
      }
      channelIds.add(creator.channelId);
      if (creator.categoryId && discordGuild.channels.cache.get(creator.categoryId)?.type !== ChannelType.GuildCategory) {
        res.status(400).json({ error: 'INVALID_CATEGORY', message: `Category ID ${creator.categoryId} không hợp lệ.` });
        return;
      }
      if (creator.allowedRoleId && !discordGuild.roles.cache.has(creator.allowedRoleId)) {
        res.status(400).json({ error: 'INVALID_ALLOWED_ROLE', message: `Role ID ${creator.allowedRoleId} không tồn tại.` });
        return;
      }
    }
  }
  const guild = sessionGuild(req.authSession, guildId);
  const developer = isDeveloper(req.authSession);
  const voicePatch = {
    creatorChannels: parsed.data.creatorChannels,
    premiumRoleId: parsed.data.premiumRoleId,
    controlChannelId: parsed.data.controlChannelId,
    defaultRoomCategoryId: parsed.data.defaultRoomCategoryId,
    roomNameTemplate: parsed.data.roomNameTemplate,
  };
  const allowedPatch = developer ? parsed.data : Object.fromEntries(Object.entries(voicePatch).filter(([, value]) => value !== undefined));
  const patch = { ...allowedPatch, ...(guild?.name ? { guildName: guild.name } : {}) };
  const settings = await store.updateSettings(guildId, patch);
  res.json({ settings });
});

const productInput = z.object({
  name: z.string().min(1).max(80),
  description: z.string().max(300).default(''),
  priceVnd: z.number().int().min(1000).max(500000000),
  roleId: z.string().max(32).default(''),
  durationDays: z.number().int().min(1).max(3650).default(30),
  active: z.boolean().default(true),
  sortOrder: z.number().int().min(0).max(999).default(0),
});

app.post('/api/guilds/:guildId/products', requireAuth, async (req: AuthRequest, res: Response) => {
  const guildId = String(req.params.guildId);
  if (!requireDeveloper(req, res)) return;
  const parsed = productInput.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'INVALID_PRODUCT', details: parsed.error.flatten() });
    return;
  }
  const product = await store.createProduct({ guildId, ...parsed.data });
  res.status(201).json({ product });
});

app.put('/api/guilds/:guildId/products/:productId', requireAuth, async (req: AuthRequest, res: Response) => {
  const guildId = String(req.params.guildId);
  const productId = String(req.params.productId);
  if (!requireDeveloper(req, res)) return;
  const existing = await store.getProduct(productId);
  if (!existing || existing.guildId !== guildId) {
    res.status(404).json({ error: 'PRODUCT_NOT_FOUND' });
    return;
  }
  const parsed = productInput.partial().safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'INVALID_PRODUCT', details: parsed.error.flatten() });
    return;
  }
  res.json({ product: await store.updateProduct(productId, parsed.data) });
});

app.delete('/api/guilds/:guildId/products/:productId', requireAuth, async (req: AuthRequest, res: Response) => {
  const guildId = String(req.params.guildId);
  const productId = String(req.params.productId);
  if (!requireDeveloper(req, res)) return;
  const existing = await store.getProduct(productId);
  if (!existing || existing.guildId !== guildId) {
    res.status(404).json({ error: 'PRODUCT_NOT_FOUND' });
    return;
  }
  await store.deleteProduct(productId);
  res.json({ ok: true });
});

app.get('/api/guilds/:guildId/sepay-status', requireAuth, async (req: AuthRequest, res: Response) => {
  const guildId = String(req.params.guildId);
  if (!requireDeveloper(req, res)) return;
  const status = await getSepayApiStatus(String(req.query.refresh || '') === '1');
  res.json({ status });
});

app.get('/api/guilds/:guildId/payments', requireAuth, async (req: AuthRequest, res: Response) => {
  const guildId = String(req.params.guildId);
  if (!requireDeveloper(req, res)) return;
  const limit = Math.min(500, Math.max(1, Number(req.query.limit || 100)));
  res.json({ payments: await store.listPayments(guildId, Number.isFinite(limit) ? limit : 100) });
});

app.get('/api/guilds/:guildId/rooms', requireAuth, async (req: AuthRequest, res: Response) => {
  const guildId = String(req.params.guildId);
  if (!requireGuildAdmin(req, res, guildId)) return;
  res.json({ rooms: (await store.listRooms(guildId)).map(({ passwordHash: _passwordHash, passwordSalt: _passwordSalt, ...room }) => ({ ...room, passwordEnabled: Boolean(_passwordHash) })) });
});

app.get('/api/guilds/:guildId/live-rooms', requireAuth, async (req: AuthRequest, res: Response) => {
  const guildId = String(req.params.guildId);
  if (!requireGuildAccess(req, res, guildId)) return;
  try {
    const admin = canManageGuild(req, guildId);
    const developer = isDeveloper(req.authSession);
    const rooms = await bot.listLiveRooms(guildId, req.authSession!.user.id, admin);
    const entitlement = await store.getEntitlement(guildId, req.authSession!.user.id);
    res.json({ rooms, admin, subscription: { premium: developer || Boolean(entitlement), founder: developer, expiresAt: developer ? '' : entitlement?.expiresAt || '', freeEditableLimit: 1 } });
  } catch (error) {
    res.status(400).json({ error: error instanceof Error ? error.message : 'Không đọc được phòng voice.' });
  }
});

const roomActionInput = z.object({
  action: z.enum(['rename', 'limit', 'lock', 'hide', 'password', 'notifications', 'invite', 'kick', 'transfer', 'delete']),
  value: z.union([z.string().max(100), z.number(), z.boolean()]).optional(),
  targetUserId: z.string().max(32).optional(),
});

app.post('/api/guilds/:guildId/live-rooms/:channelId/action', requireAuth, async (req: AuthRequest, res: Response) => {
  const guildId = String(req.params.guildId);
  if (!requireGuildAccess(req, res, guildId)) return;
  const parsed = roomActionInput.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'INVALID_ROOM_ACTION', details: parsed.error.flatten() });
    return;
  }
  try {
    const message = await bot.manageRoom({
      guildId,
      actorId: req.authSession!.user.id,
      admin: canManageGuild(req, guildId),
      channelId: String(req.params.channelId),
      ...parsed.data,
    });
    res.json({ ok: true, message });
  } catch (error) {
    res.status(400).json({ error: error instanceof Error ? error.message : 'Không thực hiện được thao tác phòng.' });
  }
});

app.get('/api/guilds/:guildId/members', requireAuth, async (req: AuthRequest, res: Response) => {
  const guildId = String(req.params.guildId);
  if (!requireGuildAdmin(req, res, guildId)) return;
  try {
    const developer = isDeveloper(req.authSession);
    const paidSummary = developer ? await store.getPaidUserSummary(guildId) : {};
    const entitlements = await store.listEntitlements(guildId);
    const activeByUser = new Set(entitlements.filter((item) => item.status === 'active' && (!item.expiresAt || new Date(item.expiresAt).getTime() > Date.now())).map((item) => item.discordUserId));
    const members = await bot.listGuildMembers(guildId, String(req.query.refresh || '') === '1');
    res.json({
      canManageMoney: developer,
      members: members.map((member) => {
        const payment = developer ? paidSummary[member.id] || { paidCount: 0, paidTotalVnd: 0, lastPaidAt: '' } : { paidCount: 0, paidTotalVnd: 0, lastPaidAt: '' };
        const founder = config.developerIds.includes(member.id);
        const premium = founder || activeByUser.has(member.id);
        return { ...member, founder, premium, paid: developer && payment.paidCount > 0, payment };
      }),
    });
  } catch (error) {
    res.status(502).json({ error: error instanceof Error ? error.message : 'Không fetch được thành viên server.' });
  }
});

app.post('/api/guilds/:guildId/payment-panel', requireAuth, async (req: AuthRequest, res: Response) => {
  const guildId = String(req.params.guildId);
  if (!requireDeveloper(req, res)) return;
  const guild = (req.authSession?.guilds || []).find((item) => item.id === guildId);
  const discordGuild = bot.client.guilds.cache.get(guildId);
  if (!discordGuild) {
    res.status(409).json({ error: 'BOT_NOT_IN_GUILD', message: 'Bot chưa ở trong server này.' });
    return;
  }
  const result = await bot.postPaymentPanel(discordGuild, await store.getSettings(guildId, guild?.name || ''));
  res.json({ ok: true, message: result });
});

app.get('/api/public/guilds/:guildId/products', async (req: Request, res: Response) => {
  const guildId = String(req.params.guildId);
  const products = (await store.listProducts(guildId, true)).map(({ id, guildId: productGuildId, name, description, priceVnd, durationDays }) => ({ id, guildId: productGuildId, name, description, priceVnd, durationDays }));
  const settings = await store.getSettings(guildId);
  res.json({ products, settings: { donationMinVnd: settings.donationMinVnd } });
});

app.post('/api/public/guilds/:guildId/payment', requireAuth, async (req: AuthRequest, res: Response) => {
  const guildId = String(req.params.guildId);
  if (!canAccessGuild(req, guildId)) {
    res.status(403).json({ error: 'GUILD_ACCESS_REQUIRED', message: 'Bạn phải là thành viên của server để mua gói.' });
    return;
  }
  const productId = String(req.body?.productId || '');
  try {
    const user = req.authSession!.user;
    const result = await createProductPayment({ guildId, userId: user.id, userTag: user.username, productId });
    res.status(201).json({ ...result, payment: { ...result.payment, qrUrl: result.payment.qrUrl, checkoutUrl: result.payment.checkoutUrl } });
  } catch (error) {
    res.status(400).json({ error: error instanceof Error ? error.message : 'Không tạo được đơn.' });
  }
});

app.post('/api/public/guilds/:guildId/donation', requireAuth, async (req: AuthRequest, res: Response) => {
  const guildId = String(req.params.guildId);
  if (!canAccessGuild(req, guildId)) {
    res.status(403).json({ error: 'GUILD_ACCESS_REQUIRED', message: 'Bạn phải là thành viên của server để donate.' });
    return;
  }
  try {
    const user = req.authSession!.user;
    const result = await createDonationPayment({ guildId, userId: user.id, userTag: user.username, amountVnd: parseVnd(req.body?.amountVnd), note: clampText(req.body?.note, 200) });
    res.status(201).json({ ...result, payment: { ...result.payment, qrUrl: result.payment.qrUrl, checkoutUrl: result.payment.checkoutUrl } });
  } catch (error) {
    res.status(400).json({ error: error instanceof Error ? error.message : 'Không tạo được đơn.' });
  }
});

app.get('/api/public/payments/:paymentId', requireAuth, async (req: AuthRequest, res: Response) => {
  let payment = await store.getPayment(String(req.params.paymentId));
  if (!payment) {
    res.status(404).json({ error: 'PAYMENT_NOT_FOUND' });
    return;
  }
  const developer = canManageMoney(req);
  const owner = payment.discordUserId === req.authSession!.user.id;
  if (!developer && !owner) {
    res.status(403).json({ error: 'PAYMENT_FORBIDDEN' });
    return;
  }
  const reconciliation = payment.status === 'pending'
    ? await reconcilePendingPayment(bot.client, payment.id)
    : { configured: isSepayApiConfigured(), checked: false, matched: payment.status === 'paid', message: '', checkedAt: '' };
  payment = await store.getPayment(payment.id) || payment;
  const settings = await store.getSettings(payment.guildId);
  res.json({ payment, reconciliation, product: payment.productId ? await store.getProduct(payment.productId) : undefined, paymentInfo: { bankCode: settings.bankCode || config.sepay.bankCode, accountNumber: settings.bankAccountNumber || config.sepay.accountNumber, accountName: settings.bankAccountName || config.sepay.accountName } });
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

app.get('/api/integrations/sgf/payments', async (req: Request, res: Response) => {
  if (!requireSgfIntegration(req, res)) return;
  const guildId = String(req.query.guildId || '');
  if (!guildId) {
    res.status(400).json({ error: 'guildId is required' });
    return;
  }
  const limit = Math.min(500, Math.max(1, Number(req.query.limit || 100)));
  res.json({ data: await store.listPayments(guildId, Number.isFinite(limit) ? limit : 100) });
});

app.get('/api/integrations/sgf/entitlements', async (req: Request, res: Response) => {
  if (!requireSgfIntegration(req, res)) return;
  const guildId = String(req.query.guildId || '');
  if (!guildId) {
    res.status(400).json({ error: 'guildId is required' });
    return;
  }
  res.json({ data: await store.listEntitlements(guildId, String(req.query.discordUserId || '') || undefined) });
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
