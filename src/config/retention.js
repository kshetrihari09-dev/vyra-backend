/** How long operational data is kept (days). Audit logs are deliberately absent: they are append-only and never purged by code. */
export const RETENTION_DAYS = {
  refreshTokensAfterExpiry: 30,
  passwordResetsAfterExpiry: 7,
  otpChallengesAfterExpiry: 1,
  notificationsRead: 90,
  notificationsAny: 180,
  outboxSent: 14,
  outboxDead: 30,
};
export const PURGE_BATCH = 5000;
