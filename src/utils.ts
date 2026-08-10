export function formatVnd(value: number): string {
  return `${new Intl.NumberFormat('vi-VN').format(Math.max(0, Math.round(value)))} ₫`;
}

export function parseVnd(value: unknown): number {
  if (typeof value === 'number') return Math.round(value);
  if (typeof value !== 'string') return 0;
  const digits = value.replace(/[^0-9]/g, '');
  return digits ? Number(digits) : 0;
}

export function clampText(value: unknown, max: number, fallback = ''): string {
  return String(value ?? fallback).trim().slice(0, max);
}

export function safeSlug(value: string): string {
  return value.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60) || 'sgf';
}

export function escapeHtml(value: unknown): string {
  return String(value ?? '').replace(/[&<>'"]/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' })[character] || character);
}

export function isDiscordAdmin(permissions: string | undefined, owner = false): boolean {
  if (owner) return true;
  try {
    return (BigInt(permissions || '0') & 0x8n) === 0x8n;
  } catch {
    return false;
  }
}

export function randomOrderCode(prefix: 'BUY' | 'DON' = 'BUY'): string {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let token = '';
  for (let index = 0; index < 8; index += 1) token += alphabet[Math.floor(Math.random() * alphabet.length)];
  return `SGF-${prefix}-${token}`;
}
