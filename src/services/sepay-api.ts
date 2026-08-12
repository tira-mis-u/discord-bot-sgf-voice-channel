import { config } from '../config.js';
import type { SepayWebhookPayload } from '../types.js';

interface SepayEnvelope<T> {
  status?: string;
  data?: T;
  message?: string;
  error_code?: string;
  meta?: unknown;
}

export interface SepayBankAccount {
  id: string;
  account_holder_name?: string;
  account_number?: string;
  label?: string;
  active?: number | boolean;
  bank_short_name?: string;
  bank_full_name?: string;
  bank_code?: string;
}

export interface SepayV2Transaction {
  id: string;
  transaction_date?: string;
  account_number?: string;
  transfer_type?: string;
  amount_in?: number | string;
  amount_out?: number | string;
  accumulated?: number | string;
  transaction_content?: string;
  reference_number?: string;
  code?: string | null;
  bank_brand_name?: string;
  bank_account_id?: string;
  webhook_success?: number | null;
}

export interface SepayApiStatus {
  configured: boolean;
  reachable: boolean;
  baseUrl: string;
  accounts: Array<{ id: string; bankCode: string; accountNumber: string; accountName: string; label: string; active: boolean }>;
  checkedAt: string;
  error: string;
}

let requestTail: Promise<void> = Promise.resolve();
let lastRequestAt = 0;
let statusCache: { at: number; value: SepayApiStatus } | undefined;

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function schedule<T>(task: () => Promise<T>): Promise<T> {
  const run = requestTail.then(async () => {
    const wait = Math.max(0, 360 - (Date.now() - lastRequestAt));
    if (wait) await delay(wait);
    lastRequestAt = Date.now();
    return task();
  });
  requestTail = run.then(() => undefined, () => undefined);
  return run;
}

async function request<T>(path: string, search?: URLSearchParams): Promise<T> {
  if (!config.sepay.apiToken) throw new Error('SEPAY_API_TOKEN chưa được cấu hình.');
  const url = new URL(`${config.sepay.apiBaseUrl}${path.startsWith('/') ? path : `/${path}`}`);
  if (search) url.search = search.toString();

  return schedule(async () => {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 10_000);
      try {
        const response = await fetch(url, {
          headers: { accept: 'application/json', authorization: `Bearer ${config.sepay.apiToken}` },
          signal: controller.signal,
        });
        const payload = await response.json().catch(() => ({})) as SepayEnvelope<T>;
        if (response.status === 429 && attempt === 0) {
          const retryAfter = Math.min(5, Math.max(1, Number(response.headers.get('retry-after') || 1)));
          await delay(retryAfter * 1000);
          continue;
        }
        if (!response.ok || payload.status === 'error') {
          const message = payload.message || payload.error_code || `HTTP ${response.status}`;
          throw new Error(`SePay API: ${message}`);
        }
        if (payload.data === undefined) throw new Error('SePay API trả về response không có data.');
        return payload.data;
      } catch (error) {
        if (error instanceof Error && error.name === 'AbortError') throw new Error('SePay API timeout sau 10 giây.');
        throw error;
      } finally {
        clearTimeout(timer);
      }
    }
    throw new Error('SePay API đang giới hạn request.');
  });
}

export function isSepayApiConfigured(): boolean {
  return Boolean(config.sepay.apiToken);
}

export async function getSepayApiStatus(force = false): Promise<SepayApiStatus> {
  if (!config.sepay.apiToken) {
    return { configured: false, reachable: false, baseUrl: config.sepay.apiBaseUrl, accounts: [], checkedAt: new Date().toISOString(), error: 'Chưa cấu hình SEPAY_API_TOKEN.' };
  }
  if (!force && statusCache && Date.now() - statusCache.at < 60_000) return statusCache.value;
  try {
    const search = new URLSearchParams({ active: '1', per_page: '100' });
    const accounts = await request<SepayBankAccount[]>('/bank-accounts', search);
    const value: SepayApiStatus = {
      configured: true,
      reachable: true,
      baseUrl: config.sepay.apiBaseUrl,
      accounts: accounts.map((account) => ({
        id: String(account.id || ''),
        bankCode: String(account.bank_code || account.bank_short_name || ''),
        accountNumber: String(account.account_number || ''),
        accountName: String(account.account_holder_name || ''),
        label: String(account.label || ''),
        active: account.active === true || Number(account.active) === 1,
      })),
      checkedAt: new Date().toISOString(),
      error: '',
    };
    statusCache = { at: Date.now(), value };
    return value;
  } catch (error) {
    const value: SepayApiStatus = {
      configured: true,
      reachable: false,
      baseUrl: config.sepay.apiBaseUrl,
      accounts: [],
      checkedAt: new Date().toISOString(),
      error: error instanceof Error ? error.message : 'Không kết nối được SePay API.',
    };
    statusCache = { at: Date.now(), value };
    return value;
  }
}

function sepayDateTime(value: string): string {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return '';
  const safeStart = new Date(date.getTime() - 86_400_000);
  return safeStart.toISOString().slice(0, 19).replace('T', ' ');
}

export async function findSepayTransactions(input: { orderCode: string; expectedAmount: number; accountNumber?: string; createdAt: string }): Promise<SepayV2Transaction[]> {
  const search = new URLSearchParams({
    q: input.orderCode,
    transfer_type: 'in',
    amount_in_min: String(Math.max(0, Math.round(input.expectedAmount))),
    transaction_date_sort: 'desc',
    per_page: '20',
  });
  const from = sepayDateTime(input.createdAt);
  if (from) search.set('transaction_date_from', from);
  const transactions = await request<SepayV2Transaction[]>('/transactions', search);
  const needle = input.orderCode.toUpperCase();
  return transactions.filter((transaction) => {
    const searchable = `${transaction.code || ''} ${transaction.transaction_content || ''} ${transaction.reference_number || ''}`.toUpperCase();
    const incoming = String(transaction.transfer_type || 'in').toLowerCase() === 'in' && Number(transaction.amount_in || 0) > 0;
    const accountMatches = !input.accountNumber || !transaction.account_number || String(transaction.account_number) === input.accountNumber;
    return incoming && accountMatches && searchable.includes(needle);
  });
}

export function transactionToWebhookPayload(transaction: SepayV2Transaction): SepayWebhookPayload {
  return {
    id: transaction.id,
    gateway: transaction.bank_brand_name,
    transactionDate: transaction.transaction_date,
    accountNumber: transaction.account_number,
    transferType: 'in',
    transferAmount: Number(transaction.amount_in || 0),
    accumulated: Number(transaction.accumulated || 0),
    code: transaction.code,
    content: transaction.transaction_content,
    referenceCode: transaction.reference_number,
    description: transaction.transaction_content,
  };
}
