import type { Client, GuildMember } from 'discord.js';
import { config } from '../config.js';
import { store } from '../db.js';
import type { Payment, Product, SepayWebhookPayload } from '../types.js';
import { formatVnd } from '../utils.js';
import { buildPaymentQr, createOrderCode, extractOrderCode, isIncoming, normalizeText, webhookAmount, webhookTransactionId } from './sepay.js';

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

function paymentDetails(guildId: string, amount: number, type: 'product' | 'donation', note = '') {
  const settings = store.getSettings(guildId);
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

export function createProductPayment(input: { guildId: string; userId: string; userTag: string; productId: string }): PaymentCreationResult {
  const product = store.getProduct(input.productId);
  if (!product || product.guildId !== input.guildId || !product.active) throw new Error('Gói Premium không tồn tại hoặc đã tắt.');
  if (product.priceVnd < 1000) throw new Error('Giá gói phải từ 1.000 ₫.');
  const details = paymentDetails(input.guildId, product.priceVnd, 'product');
  const payment = store.createPayment({
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
  store.updatePaymentCheckout(payment.id, makeCheckoutUrl(payment.id));
  const withUrl = store.getPayment(payment.id)!;
  return { payment: withUrl, product, qrDynamic: details.qr.dynamic, bankCode: details.bankCode, accountNumber: details.accountNumber, accountName: details.accountName };
}

export function createDonationPayment(input: { guildId: string; userId: string; userTag: string; amountVnd: number; note?: string }): PaymentCreationResult {
  const settings = store.getSettings(input.guildId);
  if (input.amountVnd < settings.donationMinVnd) throw new Error(`Số tiền donate tối thiểu là ${formatVnd(settings.donationMinVnd)}.`);
  const details = paymentDetails(input.guildId, input.amountVnd, 'donation', input.note);
  const payment = store.createPayment({
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
  store.updatePaymentCheckout(payment.id, makeCheckoutUrl(payment.id));
  return { payment: responsePayment, qrDynamic: details.qr.dynamic, bankCode: details.bankCode, accountNumber: details.accountNumber, accountName: details.accountName };
}

function calculateExpiry(durationDays: number, previousExpiry = ''): string {
  if (!durationDays || durationDays <= 0) return '';
  const start = previousExpiry && new Date(previousExpiry).getTime() > Date.now() ? new Date(previousExpiry) : new Date();
  start.setDate(start.getDate() + durationDays);
  return start.toISOString();
}

async function grantRole(client: Client, payment: Payment, product: Product): Promise<{ granted: boolean; message: string }> {
  const guild = await client.guilds.fetch(payment.guildId).catch(() => null);
  if (!guild) return { granted: false, message: 'Bot chưa ở trong server.' };
  const settings = store.getSettings(payment.guildId);
  const roleId = product.roleId || settings.premiumRoleId;
  if (!roleId) return { granted: false, message: 'Admin chưa cấu hình role Premium.' };
  const member = await guild.members.fetch(payment.discordUserId).catch(() => null) as GuildMember | null;
  if (!member) return { granted: false, message: 'Không tìm thấy thành viên trong server.' };
  const role = await guild.roles.fetch(roleId).catch(() => null);
  if (!role) return { granted: false, message: 'Role Premium không tồn tại hoặc bot không nhìn thấy role.' };
  const botMember = guild.members.me || await guild.members.fetch(client.user?.id || '').catch(() => null);
  if (!botMember) return { granted: false, message: 'Không xác định được member của bot trong server.' };
  if (role.position >= botMember.roles.highest.position) return { granted: false, message: 'Role Premium đang cao hơn role của bot.' };
  await member.roles.add(role, `SGF payment ${payment.orderCode}`);
  const existingEntitlement = store.getEntitlement(payment.guildId, payment.discordUserId, product.id);
  store.upsertEntitlement({ guildId: payment.guildId, discordUserId: payment.discordUserId, productId: product.id, roleId: role.id, paymentId: payment.id, expiresAt: calculateExpiry(product.durationDays, existingEntitlement?.expiresAt) });
  return { granted: true, message: `Đã cấp role ${role.name}.` };
}

export async function settleSepayWebhook(client: Client, payload: SepayWebhookPayload): Promise<{ ok: boolean; matched: boolean; payment?: Payment; message: string }> {
  const transactionId = webhookTransactionId(payload);
  if (!isIncoming(payload)) return { ok: true, matched: false, message: 'Bỏ qua giao dịch tiền ra.' };
  if (!store.recordPaymentEvent(transactionId, payload)) {
    const previous = store.getPaymentByProviderTransaction(transactionId);
    return { ok: true, matched: Boolean(previous), payment: previous, message: 'Webhook trùng, đã xử lý trước đó.' };
  }

  const orderCode = extractOrderCode(payload);
  const payment = orderCode ? store.getPaymentByCode(orderCode) : undefined;
  if (!payment || payment.status !== 'pending') {
    store.saveUnmatchedTransaction(transactionId, payload);
    return { ok: true, matched: false, message: 'Không tìm thấy đơn pending khớp mã giao dịch.' };
  }

  const amount = webhookAmount(payload);
  if (amount < payment.expectedAmountVnd) {
    store.saveUnmatchedTransaction(transactionId, { ...payload, reason: 'amount_too_low', expected: payment.expectedAmountVnd });
    return { ok: true, matched: false, payment, message: 'Số tiền nhận được nhỏ hơn số tiền đơn.' };
  }

  const paid = store.markPaymentPaid(payment.id, {
    amount,
    providerTransactionId: transactionId,
    providerReference: normalizeText(payload.referenceCode),
    transferContent: String(payload.content || payload.description || ''),
  });
  if (!paid) return { ok: true, matched: true, payment: store.getPayment(payment.id), message: 'Đơn đã được cập nhật bởi request khác.' };

  let message = 'Đã ghi nhận thanh toán.';
  if (paid.type === 'product') {
    const product = store.getProduct(paid.productId);
    if (product) {
      const roleResult = await grantRole(client, paid, product).catch((error: unknown) => ({ granted: false, message: error instanceof Error ? error.message : 'Không cấp được role.' }));
      message = roleResult.message;
    }
  }
  await notifySgf(paid);
  return { ok: true, matched: true, payment: paid, message };
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
