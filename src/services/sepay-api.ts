import { cache } from '../cache.js';
import { config } from '../config.js';
import type { GuildSettings } from '../types.js';

const SEPAY_API_BASE_URL = 'https://userapi.sepay.vn/v2';

export interface SepayBankAccount {
  id: string;
  bankCode: string;
  bankName: string;
  accountNumber: string;
  accountName: string;
  label: string;
  active: boolean;
}

interface SepayEnvelope<T> {
  status?: string;
  data?: T;
  message?: string;
  error_code?: string;
}

async function fetchAccountsWithAuthorization(authorization: string): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 10_000);
  try {
    return await fetch(`${SEPAY_API_BASE_URL}/bank-accounts?active=1&per_page=100`, {
      headers: { accept: 'application/json', authorization },
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timer);
  }
}

export async function getSepayBankAccounts(force = false): Promise<SepayBankAccount[]> {
  if (!config.sepay.apiKey) throw new Error('Chưa cấu hình SEPAY_API_KEY.');
  const cacheKey = 'sepay:bank-accounts';
  if (!force) {
    const cached = await cache.getJson<SepayBankAccount[]>(cacheKey);
    if (cached?.length) return cached;
  }

  let response = await fetchAccountsWithAuthorization(`Bearer ${config.sepay.apiKey}`);
  if (response.status === 401) response = await fetchAccountsWithAuthorization(`Apikey ${config.sepay.apiKey}`);
  const payload = await response.json().catch(() => ({})) as SepayEnvelope<Array<Record<string, unknown>>>;
  if (!response.ok || payload.status === 'error' || !Array.isArray(payload.data)) {
    throw new Error(`Không đọc được tài khoản SePay: ${payload.message || payload.error_code || `HTTP ${response.status}`}`);
  }

  const accounts = payload.data.map((row): SepayBankAccount => ({
    id: String(row.id || row.xid || ''),
    bankCode: String(row.bank_code || row.bank_short_name || row.bank_brand_name || ''),
    bankName: String(row.bank_full_name || row.bank_brand_name || row.bank_short_name || ''),
    accountNumber: String(row.account_number || ''),
    accountName: String(row.account_holder_name || row.account_name || ''),
    label: String(row.label || ''),
    active: row.active === undefined || row.active === true || Number(row.active) === 1,
  })).filter((account) => account.active && account.accountNumber && account.bankCode);

  if (!accounts.length) throw new Error('SePay API không trả về tài khoản ngân hàng active nào.');
  await cache.setJson(cacheKey, accounts, 10 * 60);
  return accounts;
}

export async function resolveSepayBankAccount(settings: GuildSettings): Promise<SepayBankAccount> {
  if (config.sepay.apiKey) {
    try {
      const accounts = await getSepayBankAccounts();
      return accounts.find((account) => account.id === settings.sepayBankAccountId) || accounts[0];
    } catch (error) {
      if (!settings.bankCode && !config.sepay.bankCode) throw error;
    }
  }

  const bankCode = settings.bankCode || config.sepay.bankCode;
  const accountNumber = settings.bankAccountNumber || config.sepay.accountNumber;
  const accountName = settings.bankAccountName || config.sepay.accountName;
  if (!bankCode || !accountNumber) throw new Error('Không tìm thấy tài khoản nhận tiền. Hãy cấu hình SEPAY_API_KEY hoặc chọn tài khoản SePay trong Dashboard.');
  return { id: settings.sepayBankAccountId, bankCode, bankName: bankCode, accountNumber, accountName, label: 'Legacy manual account', active: true };
}

export const sepayApiBaseUrl = SEPAY_API_BASE_URL;
