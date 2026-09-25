import { unavailable } from "../utils/errors.js";

/**
 * Delivery channel abstraction for OTPs and reset links. Phase 8 (notifications) plugs real email / SMS /
 * push providers in behind this same interface — auth code never needs to change.
 *
 *   sendSms({ to, text })
 *   sendEmail({ to, subject, text })
 */
export function createNotifier({ driver, logger }) {
  if (driver === "console") {
    return {
      async sendSms({ to, text }) { logger.info("[notify:console] sms", { to, text }); },
      async sendEmail({ to, subject, text }) { logger.info("[notify:console] email", { to, subject, text }); },
    };
  }
  const refuse = async () => { throw unavailable("NOTIFIER_UNAVAILABLE", "Messaging is not configured on this server yet."); };
  return { sendSms: refuse, sendEmail: refuse };
}
