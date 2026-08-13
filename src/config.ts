import 'dotenv/config';

function numberFromEnv(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}


function textFromEnv(name: string, fallback = ''): string {
  return String(process.env[name] ?? fallback).trim();
}

const inferredPublicUrl = process.env.VERCEL_PROJECT_PRODUCTION_URL
  ? `https://${String(process.env.VERCEL_PROJECT_PRODUCTION_URL).replace(/^https?:\/\//, '').replace(/\/$/, '')}`
  : 'http://localhost:3000';
const publicUrl = textFromEnv('PUBLIC_URL', inferredPublicUrl).replace(/\/$/, '');
const isVercel = Boolean(process.env.VERCEL);
const configuredDbFile = textFromEnv('DB_FILE', './data/sgf.sqlite');
const dbFile = isVercel && !configuredDbFile.startsWith('/tmp/')
  ? `/tmp/${configuredDbFile.split(/[\\/]/).pop() || 'sgf.sqlite'}`
  : configuredDbFile;

export const config = {
  nodeEnv: textFromEnv('NODE_ENV', 'development'),
  port: numberFromEnv(process.env.PORT, 3000),
  publicUrl,
  isVercel,
  dbFile,
  databasePersistence: isVercel ? 'ephemeral' as const : 'persistent' as const,
  databaseUrl: textFromEnv('DATABASE_URL'),
  directDatabaseUrl: textFromEnv('DIRECT_DATABASE_URL'),
  supabase: {
    url: textFromEnv('SUPABASE_URL'),
    serviceRoleKey: textFromEnv('SUPABASE_SERVICE_ROLE_KEY'),
  },
  redis: {
    url: textFromEnv('REDIS_URL'),
    upstashRestUrl: textFromEnv('UPSTASH_REDIS_REST_URL'),
    upstashRestToken: textFromEnv('UPSTASH_REDIS_REST_TOKEN'),
  },
  developerIds: [textFromEnv('DEV_DANTE'), textFromEnv('DEV_TIRA')].filter(Boolean),
  sessionSecret: textFromEnv('SESSION_SECRET', 'dev-only-session-secret'),
  discord: {
    token: textFromEnv('DISCORD_TOKEN'),
    clientId: textFromEnv('DISCORD_CLIENT_ID'),
    clientSecret: textFromEnv('DISCORD_CLIENT_SECRET'),
    redirectUri: textFromEnv('DISCORD_REDIRECT_URI', `${publicUrl}/auth/discord/callback`),
  },
  sepay: {
    apiKey: textFromEnv('SEPAY_API_KEY'),
    webhookApiKey: textFromEnv('SEPAY_WEBHOOK_API_KEY', textFromEnv('SEPAY_API_KEY')),
    bankCode: process.env.SEPAY_BANK_CODE || '',
    accountNumber: process.env.SEPAY_ACCOUNT_NUMBER || '',
    accountName: process.env.SEPAY_ACCOUNT_NAME || '',
    staticQrUrl: process.env.SEPAY_STATIC_QR_URL || '',
    qrBaseUrl: 'https://vietqr.app/img',
  },
  sgf: {
    integrationSecret: process.env.SGF_INTEGRATION_SECRET || '',
    eventsWebhookUrl: process.env.SGF_EVENTS_WEBHOOK_URL || '',
  },
};

export function isProduction(): boolean {
  return config.nodeEnv === 'production';
}

export function assertProductionConfig(): void {
  if (!isProduction()) return;
  const missing: string[] = [];
  if (!config.discord.token) missing.push('DISCORD_TOKEN');
  if (!config.discord.clientId) missing.push('DISCORD_CLIENT_ID');
  if (!config.discord.clientSecret) missing.push('DISCORD_CLIENT_SECRET');
  if (!process.env.PUBLIC_URL && !process.env.VERCEL_PROJECT_PRODUCTION_URL) missing.push('PUBLIC_URL');
  if (/localhost|127\.0\.0\.1/i.test(config.publicUrl)) missing.push('PUBLIC_URL must be a public HTTPS URL');
  if (!config.sepay.apiKey) missing.push('SEPAY_API_KEY');
  if (!config.sgf.integrationSecret) missing.push('SGF_INTEGRATION_SECRET');
  if (config.sessionSecret === 'dev-only-session-secret') missing.push('SESSION_SECRET');
  if (missing.length) throw new Error(`Missing production environment variables: ${missing.join(', ')}`);
}
