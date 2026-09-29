import { TEMPLATES, LINK_KEYS } from "../notifications/templates.js";
import { notFound } from "../utils/errors.js";

const OUTBOX = { maxAttempts: 5, backoffBaseSeconds: 30, batch: 25, leaseSeconds: 120 };
const backoff = (attempt) => OUTBOX.backoffBaseSeconds * 4 ** (attempt - 1); // 30 s, 2 min, 8 min, 32 min

export const toNotificationDto = (r) => ({
  id: r.id, type: r.type, kind: r.kind, title: r.title, message: r.message, data: r.data ?? {},
  unread: !r.read_at, createdAt: r.created_at,
});

/**
 * Notifications = an in-app inbox row (always) + optional outbox rows for email / SMS. `emit` takes the caller's
 * transaction client so the notification commits or rolls back with the change that caused it. Sending happens later,
 * in `processOutbox`, so a slow or failing SMS/email provider can never slow down or fail an order.
 */
export function createNotificationsService({ pool, repo, notifier, logger, externalEnabled = true }) {
  return {
    /**
     * `data` is the template input AND the deep-link payload: only ids in LINK_KEYS are stored on the inbox row.
     * Unknown types throw immediately (a typo must fail in development, not silently notify nobody).
     */
    async emit(db, { userId, type, data = {} }) {
      const tpl = TEMPLATES[type];
      if (!tpl) throw new Error(`Unknown notification type: ${type}`);
      if (!userId) return null;
      const title = tpl.title(data);
      const message = tpl.message(data);
      const link = Object.fromEntries(LINK_KEYS.filter((k) => data[k] !== undefined).map((k) => [k, data[k]]));
      const row = await repo.insert(db, { userId, type, kind: tpl.kind, title, message, data: link });

      if (externalEnabled && (tpl.email || tpl.sms)) {
        const contact = await repo.getContact(db, userId);
        if (contact) {
          if (tpl.email && contact.email && contact.notify_email) await repo.enqueue(db, { userId, channel: "email", to: contact.email, subject: title, body: message, type });
          if (tpl.sms && contact.mobile && contact.notify_sms) await repo.enqueue(db, { userId, channel: "sms", to: contact.mobile, body: message, type });
        }
      }
      return row;
    },

    // ---------------------------------------------------------------- inbox API
    async list(actor, { unread, limit = 30, before } = {}) {
      const rows = await repo.list(pool, actor.id, { unreadOnly: !!unread, limit, before });
      return { notifications: rows.map(toNotificationDto), unread: await repo.unreadCount(pool, actor.id) };
    },
    async markRead(actor, id) {
      if (!(await repo.markRead(pool, actor.id, id))) throw notFound("NOTIFICATION_NOT_FOUND", "Notification not found");
      return { unread: await repo.unreadCount(pool, actor.id) };
    },
    async markAllRead(actor) {
      await repo.markAllRead(pool, actor.id);
      return { unread: 0 };
    },
    async getPreferences(actor) {
      const c = await repo.getContact(pool, actor.id);
      return { email: c.notify_email, sms: c.notify_sms };
    },
    async setPreferences(actor, body) {
      const c = await repo.setPreferences(pool, actor.id, body);
      return { email: c.notify_email, sms: c.notify_sms };
    },

    // ------------------------------------------------------------------- worker
    /**
     * Sends what is due. A failure never throws out of here: the row is rescheduled with exponential backoff and, after
     * `maxAttempts`, marked dead (kept for investigation, purged by the retention job). Returns counts for the logs.
     */
    async processOutbox({ limit = OUTBOX.batch } = {}) {
      const batch = await repo.claimDue(pool, { limit, leaseSeconds: OUTBOX.leaseSeconds });
      const out = { sent: 0, retried: 0, dead: 0 };
      for (const m of batch) {
        try {
          if (m.channel === "sms") await notifier.sendSms({ to: m.to_address, text: m.body });
          else await notifier.sendEmail({ to: m.to_address, subject: m.subject ?? "Vyra", text: m.body });
          await repo.markSent(pool, m.id);
          out.sent++;
        } catch (err) {
          const error = String(err?.message ?? err).slice(0, 300);
          if (m.attempts >= OUTBOX.maxAttempts) {
            await repo.markDead(pool, m.id, { error });
            out.dead++;
            logger?.error("notification undeliverable", { id: m.id, channel: m.channel, type: m.type, error });
          } else {
            await repo.markRetry(pool, m.id, { delaySeconds: backoff(m.attempts), error });
            out.retried++;
          }
        }
      }
      return out;
    },
    outboxStats: () => repo.outboxStats(pool),
  };
}

export const NOTIFICATION_OUTBOX_RULES = OUTBOX;
