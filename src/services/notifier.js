import { unavailable } from "../utils/errors.js";

/**
 * Delivery channel abstraction for OTPs and reset links. Phase 8 (notifications) plugs real email / SMS /
 * push providers in behind this same interface — auth code never needs to change.
 *
 *   sendSms({ to, text })
 *   sendEmail({ to, subject, text })
 */
export function createNotifier({ driver, logger, twilio }) {
  if (driver === "console") {
    return {
      async sendSms({ to, text }) { logger.info("[notify:console] sms", { to, text }); },
      async sendEmail({ to, subject, text }) { logger.info("[notify:console] email", { to, subject, text }); },
    };
  }

  if (driver === "twilio") {
    const authHeader = "Basic " + Buffer.from(`${twilio.accountSid}:${twilio.authToken}`).toString("base64");
    const url = `https://api.twilio.com/2010-04-01/Accounts/${twilio.accountSid}/Messages.json`;

    const sendSms = async ({ to, text }) => {
      const body = new URLSearchParams({ To: to, From: twilio.fromNumber, Body: text });
      const res = await fetch(url, {
        method: "POST",
        headers: { Authorization: authHeader, "Content-Type": "application/x-www-form-urlencoded" },
        body,
      });
      if (!res.ok) {
        const detail = await res.text().catch(() => "");
        logger.error("[notify:twilio] sms failed", { to, status: res.status, detail });
        throw unavailable("NOTIFIER_SEND_FAILED", "Could not send the verification code. Please try again.");
      }
      logger.info("[notify:twilio] sms sent", { to });
    };

    // Twilio's SMS-only setup has no email leg; email OTP/reset falls back to a hard refusal
    // until an email provider (SES, Postmark, etc.) is wired in the same way.
    const refuseEmail = async () => { throw unavailable("NOTIFIER_UNAVAILABLE", "Email delivery is not configured on this server yet."); };

    return { sendSms, sendEmail: refuseEmail };
  }

  const refuse = async () => { throw unavailable("NOTIFIER_UNAVAILABLE", "Messaging is not configured on this server yet."); };
  return { sendSms: refuse, sendEmail: refuse };
}
