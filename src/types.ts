export type CreatorMode = 'basic' | 'editable';
export type PaymentType = 'product' | 'donation';
export type PaymentStatus = 'pending' | 'paid' | 'expired' | 'cancelled';

export interface CreatorChannelConfig {
  channelId: string;
  label: string;
  mode: CreatorMode;
  categoryId?: string;
  allowedRoleId?: string;
  notifyJoinLeave?: boolean;
  autoTransferOwner?: boolean;
}

export interface GuildSettings {
  guildId: string;
  guildName: string;
  creatorChannels: CreatorChannelConfig[];
  premiumRoleId: string;
  controlChannelId: string;
  paymentPanelChannelId: string;
  defaultRoomCategoryId: string;
  roomNameTemplate: string;
  donationMinVnd: number;
  bankCode: string;
  bankAccountNumber: string;
  bankAccountName: string;
  staticQrUrl: string;
  updatedAt: string;
}

export interface Product {
  id: string;
  guildId: string;
  name: string;
  description: string;
  priceVnd: number;
  roleId: string;
  durationDays: number;
  active: boolean;
  sortOrder: number;
  createdAt: string;
  updatedAt: string;
}

export interface Room {
  id: string;
  guildId: string;
  channelId: string;
  ownerId: string;
  ownerTag: string;
  mode: CreatorMode;
  creatorChannelId: string;
  controlMessageId: string;
  notifyJoinLeave: boolean;
  passwordHash: string;
  passwordSalt: string;
  createdAt: string;
}

export interface Payment {
  id: string;
  guildId: string;
  discordUserId: string;
  discordUserTag: string;
  type: PaymentType;
  productId: string;
  orderCode: string;
  expectedAmountVnd: number;
  paidAmountVnd: number;
  status: PaymentStatus;
  providerTransactionId: string;
  providerReference: string;
  transferContent: string;
  qrUrl: string;
  checkoutUrl: string;
  note: string;
  paidAt: string;
  createdAt: string;
  updatedAt: string;
}

export interface Entitlement {
  id: string;
  guildId: string;
  discordUserId: string;
  productId: string;
  roleId: string;
  paymentId: string;
  grantedBy: string;
  grantNote: string;
  status: 'active' | 'expired' | 'revoked';
  expiresAt: string;
  createdAt: string;
  updatedAt: string;
}

export interface SessionUser {
  id: string;
  username: string;
  globalName?: string;
  avatar?: string;
}

export interface OAuthGuild {
  id: string;
  name: string;
  icon?: string;
  owner?: boolean;
  permissions?: string;
}

export interface AuthSession {
  id: string;
  user: SessionUser;
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
  guilds: OAuthGuild[];
}

export interface SepayWebhookPayload {
  id?: string | number;
  gateway?: string;
  transactionDate?: string;
  accountNumber?: string;
  subAccount?: string;
  transferType?: string;
  transferAmount?: number | string;
  accumulated?: number | string;
  code?: string | null;
  content?: string;
  referenceCode?: string;
  description?: string;
}
