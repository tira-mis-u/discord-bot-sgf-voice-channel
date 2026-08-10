import crypto from 'node:crypto';
import { config } from '../config.js';
import type { GuildSettings, SepayWebhookPayload } from '../types.js';
import { randomOrderCode } from '../utils.js';

export function createOrderCode(type: 'product' | 'donation'): string {
  return randomOrderCode(type === 'donation' ? 'DON' : 'BUY');
}

export function buildPaymentQr(settings: GuildSettings, amount: number, orderCode: string): { url: string; dynamic: boolean } {
  const bankCode = settings.bankCode || config.sepay.bankCode;
  const accountNumber = settings.bankAccountNumber || config.sepay.accountNumber;
  // A per-guild static QR is an explicit override. Otherwise prefer dynamic QR whenever bank + account are configured, and use the global static QR only as fallback.
  if (settings.staticQrUrl) return { url: settings.staticQrUrl, dynamic: false };
  if (!bankCode || !accountNumber) {
    if (config.sepay.staticQrUrl) return { url: config.sepay.staticQrUrl, dynamic: false };
    return { url: '', dynamic: false };
  }

  const url = new URL(config.sepay.qrBaseUrl);
  url.searchParams.set('acc', accountNumber);
  url.searchParams.set('bank', bankCode);
  url.searchParams.set('amount', String(Math.round(amount)));
  url.searchParams.set('des', orderCode);
  return { url: url.toString(), dynamic: true };
}

export function verifySepayWebhook(headers: Record<string, unknown>): boolean {
  if (!config.sepay.webhookApiKey) return false;
  const authorization = String(headers.authorization || headers.Authorization || '');
  const apiKeyHeader = String(headers['x-api-key'] || '');
  const candidates = [authorization, apiKeyHeader];
  return candidates.some((candidate) => {
    const expected = candidate.startsWith('Apikey ') ? `Apikey ${config.sepay.webhookApiKey}` : config.sepay.webhookApiKey;
    return candidate.length === expected.length && crypto.timingSafeEqual(Buffer.from(candidate), Buffer.from(expected));
  });
}

export function normalizeText(value: unknown): string {
  return String(value ?? '').toUpperCase().replace(/\s+/g, ' ').trim();
}

export function extractOrderCode(payload: SepayWebhookPayload): string {
  const explicit = normalizeText(payload.code);
  if (explicit.startsWith('SGF-')) return explicit;
  const content = normalizeText(payload.content || payload.description);
  const match = content.match(/SGF-(?:BUY|DON)-[A-Z0-9]{8}/);
  return match?.[0] || explicit;
}

export function webhookTransactionId(payload: SepayWebhookPayload): string {
  return String(payload.id || payload.referenceCode || `${payload.transactionDate || 'unknown'}:${payload.content || ''}:${payload.transferAmount || ''}`);
}

export function webhookAmount(payload: SepayWebhookPayload): number {
  const amount = Number(payload.transferAmount || 0);
  return Number.isFinite(amount) ? Math.round(amount) : 0;
}

export function isIncoming(payload: SepayWebhookPayload): boolean {
  return String(payload.transferType || '').toLowerCase() === 'in';
}
