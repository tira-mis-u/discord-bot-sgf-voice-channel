import type { Client, GuildMember } from 'discord.js';
import { config } from '../config.js';
import { cache } from '../cache.js';
import { store } from '../db.js';
import type { Payment, Product, SepayWebhookPayload } from '../types.js';
import { formatVnd } from '../utils.js';
import { buildPaymentQr, createOrderCode, extractOrderCode, isIncoming, normalizeText, webhookAmount, webhookTransactionId } from './sepay.js';
import { findSepayTransactions, isSepayApiConfigured, transactionToWebhookPayload } from './sepay-api.js';

export interface PaymentCreationResult {
  payment: Payment;
  product?: Product;
  qrDynamic: boolean;
  bankCode: string;
  accountNumber: string;
  accountName: string;
}

export function makeCheckoutUrl(paymentId: string): string {
  return `${config.publicUrl}/checkout/payment/${encodeURIComponent(paymentId)}`;
}

async function paymentDetails(guildId: string, amount: number, type: 'product' | 'donation', note = '') {
  const settings = await store.getSettings(guildId);
  const orderCode = createOrderCode(type);
  const qr = buildPaymentQr(settings, amount, orderCode);
  return {
    settings,
    orderCode,
    qr,
    bankCode: settings.bankCode || config.sepay.bankCode,
    accountNumber: settings.bankAccountNumber || config.sepay.accountNumber,
    accountName: settings.bankAccountName || config.sepay.accountName,
    note,
  };
}

export async function createProductPayment(input: { guildId: string; userId: string; userTag: string; productId: string }): Promise<PaymentCreationResult> {
  const product = await store.getProduct(input.productId);
  if (!product || product.guildId !== input.guildId || !product.active) throw new Error('Gói Premium không tồn tại hoặc đã tắt.');
  if (product.priceVnd < 1000) throw new Error('Giá gói phải từ 1.000 ₫.');
  const details = await paymentDetails(input.guildId, product.priceVnd, 'product');
  const payment = await store.createPayment({
    guildId: input.guildId,
    discordUserId: input.userId,
    discordUserTag: input.userTag,
    type: 'product',
    productId: product.id,
    orderCode: details.orderCode,
    expectedAmountVnd: product.priceVnd,
    qrUrl: details.qr.url,
    checkoutUrl: '',
    note: product.name,
  });
  await store.updatePaymentCheckout(payment.id, makeCheckoutUrl(payment.id));
  const withUrl = (await store.getPayment(payment.id))!;
  return { payment: withUrl, product, qrDynamic: details.qr.dynamic, bankCode: details.bankCode, accountNumber: details.accountNumber, accountName: details.accountName };
}

export async function createDonationPayment(input: { guildId: string; userId: string; userTag: string; amountVnd: number; note?: string }): Promise<PaymentCreationResult> {
  const settings = await store.getSettings(input.guildId);
  if (input.amountVnd < settings.donationMinVnd) throw new Error(`Số tiền donate tối thiểu là ${formatVnd(settings.donationMinVnd)}.`);
  const details = await paymentDetails(input.guildId, input.amountVnd, 'donation', input.note);
  const payment = await store.createPayment({
    guildId: input.guildId,
    discordUserId: input.userId,
    discordUserTag: input.userTag,
    type: 'donation',
    orderCode: details.orderCode,
    expectedAmountVnd: input.amountVnd,
    qrUrl: details.qr.url,
    checkoutUrl: '',
    note: input.note || 'Donate cho SGF',
  });
  const responsePayment = { ...payment, checkoutUrl: makeCheckoutUrl(payment.id) };
  await store.updatePaymentCheckout(payment.id, makeCheckoutUrl(payment.id));
  return { payment: responsePayment, qrDynamic: details.qr.dynamic, bankCode: details.bankCode, accountNumber: details.accountNumber, accountName: details.accountName };
}

export function calculateExpiry(durationDays: number, previousExpiry = ''): string {
  if (!durationDays || durationDays <= 0) return '';
  const start = previousExpiry && new Date(previousExpiry).getTime() > Date.now() ? new Date(previousExpiry) : new Date();
  start.setDate(start.getDate() + durationDays);
  return start.toISOString();
}

async function grantRole(client: Client, payment: Payment, product: Product): Promise<{ granted: boolean; message: string }> {
  const settings = await store.getSettings(payment.guildId);
  const roleId = product.roleId || settings.premiumRoleId;
  const existingEntitlement = await store.getEntitlement(payment.guildId, payment.discordUserId, product.id);
  const expiresAt = calculateExpiry(product.durationDays, existingEntitlement?.expiresAt);
  await store.upsertEntitlement({ guildId: payment.guildId, discordUserId: payment.discordUserId, productId: product.id, roleId, paymentId: payment.id, expiresAt });

  const guild = await client.guilds.fetch(payment.guildId).catch(() => null);
  if (!guild) return { granted: true, message: 'Premium đã kích hoạt, nhưng bot hiện không truy cập được server để cấp role.' };
  if (!roleId) return { granted: true, message: `Premium đã kích hoạt đến ${expiresAt ? new Date(expiresAt).toLocaleDateString('vi-VN') : 'vĩnh viễn'}.` };
  const member = await guild.members.fetch(payment.discordUserId).catch(() => null) as GuildMember | null;
  if (!member) return { granted: true, message: 'Premium đã kích hoạt, nhưng không tìm thấy member để cấp role.' };
  const role = await guild.roles.fetch(roleId).catch(() => null);
  if (!role) return { granted: true, message: 'Premium đã kích hoạt, nhưng role cấu hình không còn tồn tại.' };
  const botMember = guild.members.me || await guild.members.fetch(client.user?.id || '').catch(() => null);
  if (!botMember || role.position >= botMember.roles.highest.position) return { granted: true, message: 'Premium đã kích hoạt, nhưng bot chưa đủ quyền cấp role.' };
  await member.roles.add(role, `SGF payment ${payment.orderCode}`);
  return { granted: true, message: `Đã gia hạn Premium và cấp role ${role.name} đến ${expiresAt ? new Date(expiresAt).toLocaleDateString('vi-VN') : 'vĩnh viễn'}.` };
}

export async function settleSepayWebhook(client: Client, payload: SepayWebhookPayload): Promise<{ ok: boolean; matched: boolean; payment?: Payment; message: string }> {
  const transactionId = webhookTransactionId(payload);
  if (!isIncoming(payload)) return { ok: true, matched: false, message: 'Bỏ qua giao dịch tiền ra.' };
  if (!await store.recordPaymentEvent(transactionId, payload)) {
    const previous = await store.getPaymentByProviderTransaction(transactionId);
    return { ok: true, matched: Boolean(previous), payment: previous, message: 'Webhook trùng, đã xử lý trước đó.' };
  }

  const orderCode = extractOrderCode(payload);
  const payment = orderCode ? await store.getPaymentByCode(orderCode) : undefined;
  if (!payment || payment.status !== 'pending') {
    await store.saveUnmatchedTransaction(transactionId, payload);
    return { ok: true, matched: false, message: 'Không tìm thấy đơn pending khớp mã giao dịch.' };
  }

  const amount = webhookAmount(payload);
  if (amount < payment.expectedAmountVnd) {
    await store.saveUnmatchedTransaction(transactionId, { ...payload, reason: 'amount_too_low', expected: payment.expectedAmountVnd });
    return { ok: true, matched: false, payment, message: 'Số tiền nhận được nhỏ hơn số tiền đơn.' };
  }

  const paid = await store.markPaymentPaid(payment.id, {
    amount,
    providerTransactionId: transactionId,
    providerReference: normalizeText(payload.referenceCode),
    transferContent: String(payload.content || payload.description || ''),
  });
  if (!paid) return { ok: true, matched: true, payment: await store.getPayment(payment.id), message: 'Đơn đã được cập nhật bởi request khác.' };

  let message = 'Đã ghi nhận thanh toán.';
  if (paid.type === 'product') {
    const product = await store.getProduct(paid.productId);
    if (product) {
      const roleResult = await grantRole(client, paid, product).catch((error: unknown) => ({ granted: false, message: error instanceof Error ? error.message : 'Không cấp được role.' }));
      message = roleResult.message;
    }
  }
  await notifySgf(paid);
  return { ok: true, matched: true, payment: paid, message };
}

export interface ReconciliationResult {
  configured: boolean;
  checked: boolean;
  matched: boolean;
  message: string;
  checkedAt: string;
}

const reconciliationCache = new Map<string, { at: number; result: ReconciliationResult }>();
const reconciliationInFlight = new Map<string, Promise<ReconciliationResult>>();

export async function reconcilePendingPayment(client: Client, paymentId: string, force = false): Promise<ReconciliationResult> {
  const payment = await store.getPayment(paymentId);
  const checkedAt = new Date().toISOString();
  if (!isSepayApiConfigured()) return { configured: false, checked: false, matched: false, message: 'Chưa cấu hình SEPAY_API_TOKEN.', checkedAt };
  if (!payment) return { configured: true, checked: false, matched: false, message: 'Không tìm thấy đơn thanh toán.', checkedAt };
  if (payment.status !== 'pending') return { configured: true, checked: false, matched: payment.status === 'paid', message: `Đơn đang ở trạng thái ${payment.status}.`, checkedAt };

  const reconciliationKey = `sepay-reconciliation:${paymentId}`;
  if (!force && cache.backend !== 'memory') {
    const distributedCached = await cache.getJson<ReconciliationResult>(reconciliationKey);
    if (distributedCached) return distributedCached;
  }
  const cached = reconciliationCache.get(paymentId);
  if (!force && cached && Date.now() - cached.at < 15_000) return cached.result;
  const running = reconciliationInFlight.get(paymentId);
  if (running) return running;
  const lockKey = `sepay-lock:${paymentId}`;
  if (cache.backend !== 'memory' && !await cache.setIfAbsent(lockKey, '1', 15)) {
    return { configured: true, checked: false, matched: false, message: 'Một worker khác đang đối soát đơn này.', checkedAt };
  }

  const task = (async () => {
    try {
      const settings = await store.getSettings(payment.guildId);
      const transactions = await findSepayTransactions({
        orderCode: payment.orderCode,
        expectedAmount: payment.expectedAmountVnd,
        accountNumber: settings.bankAccountNumber || config.sepay.accountNumber,
        createdAt: payment.createdAt,
      });
      for (const transaction of transactions) {
        const result = await settleSepayWebhook(client, transactionToWebhookPayload(transaction));
        if (result.matched) {
          return { configured: true, checked: true, matched: true, message: `Đã đối soát bằng SePay API v2. ${result.message}`, checkedAt: new Date().toISOString() };
        }
      }
      return { configured: true, checked: true, matched: false, message: 'SePay API chưa tìm thấy giao dịch khớp mã đơn và số tiền.', checkedAt: new Date().toISOString() };
    } catch (error) {
      return { configured: true, checked: true, matched: false, message: error instanceof Error ? error.message : 'Đối soát SePay API thất bại.', checkedAt: new Date().toISOString() };
    }
  })();
  reconciliationInFlight.set(paymentId, task);
  try {
    const result = await task;
    reconciliationCache.set(paymentId, { at: Date.now(), result });
    if (cache.backend !== 'memory') await cache.setJson(reconciliationKey, result, 15);
    return result;
  } finally {
    reconciliationInFlight.delete(paymentId);
    if (cache.backend !== 'memory') await cache.del(lockKey);
  }
}

async function notifySgf(payment: Payment): Promise<void> {
  if (!config.sgf.eventsWebhookUrl) return;
  try {
    await fetch(config.sgf.eventsWebhookUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...(config.sgf.integrationSecret ? { authorization: `Bearer ${config.sgf.integrationSecret}` } : {}) },
      body: JSON.stringify({ event: 'payment.paid', occurredAt: new Date().toISOString(), payment }),
    });
  } catch (error) {
    console.error('[SGF integration] event delivery failed', error);
  }
}
