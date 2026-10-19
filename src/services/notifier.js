import { createHmac } from "node:crypto";
import { unavailable } from "../utils/errors.js";

/**
 * Delivery channel abstraction for OTPs, reset links and outbox messages. Drivers: console (dev only — logs the
 * message), disabled (refuses), webhook (signed POST to your SMS/email gateway), brevo (Brevo's REST API directly).
 *
 *   sendSms({ to, text })
 *   sendEmail({ to, subject, text })
 */
export function createNotifier({ driver, logger, webhookUrl, webhookSecret, brevo, timeoutMs = 8000, fetchImpl = globalThis.fetch, clock = () => Date.now() }) {
  if (driver === "webhook") {
    /**
     * POSTs {channel, to, subject?, text} as JSON to the gateway. The body is signed so the gateway can trust it:
     *   X-Vyra-Timestamp: <unix ms>      X-Vyra-Signature: sha256=HMAC(secret, `${timestamp}.${rawBody}`)
     * (the timestamp is inside the signature so a captured request can't be replayed later — verify it is recent).
     * Non-2xx or a timeout throws; the outbox worker retries. The error text never contains the URL or the message.
     */
    const post = async (payload) => {
      const body = JSON.stringify(payload);
      const ts = String(clock());
      const signature = createHmac("sha256", webhookSecret).update(`${ts}.${body}`).digest("hex");
      let res;
      try {
        res = await fetchImpl(webhookUrl, {
          method: "POST",
          headers: { "content-type": "application/json", "x-vyra-timestamp": ts, "x-vyra-signature": `sha256=${signature}` },
          body, signal: AbortSignal.timeout(timeoutMs), redirect: "error",
        });
      } catch (err) {
        throw new Error(err?.name === "TimeoutError" ? "notification gateway timed out" : "notification gateway unreachable");
      }
      if (!res.ok) throw new Error(`notification gateway responded ${res.status}`);
    };
    return {
      sendSms: ({ to, text }) => post({ channel: "sms", to, text }),
      // `replyTo` is passed to the gateway as an extra field; a gateway that ignores it still sends the message.
      sendEmail: ({ to, subject, text, replyTo }) => post({ channel: "email", to, subject, text, ...(replyTo ? { replyTo } : {}) }),
      driver, deliversExternally: true,
    };
  }
  if (driver === "brevo") {
    /**
     * Brevo transactional email (POST /v3/smtp/email) and transactional SMS (POST /v3/transactionalSMS/send), authenticated with
     * the `api-key` header. Brevo wants SMS recipients as digits WITH the country code and no "+": a 10-digit national number
     * (how Vaspoor stores Nepal mobiles, e.g. 9812345678) gets the configured country code (default 977) in front.
     * Non-2xx or a timeout throws so the outbox worker retries; the error text never contains the key, the number or the message.
     */
    const fail = (channel, reason, detail = {}) => {
      // The operator needs Brevo's own explanation (bad key, no SMS credits, unverified sender…); the customer just needs to know to retry.
      logger?.error?.("[notify:brevo] send failed", { channel, reason, ...detail });
      return unavailable("NOTIFIER_FAILED", "We couldn't send the message right now. Please try again in a few minutes.");
    };
    const call = async (channel, path, payload) => {
      let res;
      try {
        res = await fetchImpl(`https://api.brevo.com/v3${path}`, {
          method: "POST",
          headers: { "api-key": brevo.apiKey, "content-type": "application/json", accept: "application/json" },
          body: JSON.stringify(payload), signal: AbortSignal.timeout(timeoutMs), redirect: "error",
        });
      } catch (err) {
        throw fail(channel, err?.name === "TimeoutError" ? "Brevo timed out" : "Brevo unreachable");
      }
      if (!res.ok) {
        const body = await res.json?.().catch(() => null);
        throw fail(channel, `Brevo responded ${res.status}`, { status: res.status, brevoCode: body?.code, brevoMessage: body?.message });
      }
    };
    const smsRecipient = (to) => {
      const d = String(to ?? "").replace(/\D/g, "");
      return d.length <= 10 ? `${brevo.countryCode}${d.replace(/^0+/, "")}` : d;
    };
    return {
      sendSms: ({ to, text }) => call("sms", "/transactionalSMS/send", { sender: brevo.smsSender, recipient: smsRecipient(to), content: text, type: "transactional" }),
      sendEmail: ({ to, subject, text, replyTo }) => call("email", "/smtp/email", {
        sender: { name: brevo.senderName, email: brevo.senderEmail }, to: [{ email: to }], subject, textContent: text,
        ...(replyTo ? { replyTo: { email: replyTo } } : {}),
      }),
      driver, deliversExternally: true,
    };
  }
  if (driver === "console") {
    return {
      async sendSms({ to, text }) { logger.info("[notify:console] sms", { to, text }); },
      async sendEmail({ to, subject, text }) { logger.info("[notify:console] email", { to, subject, text }); },
      // Logging is NOT delivery: callers that must not claim success on a log line check this flag.
      driver, deliversExternally: false,
    };
  }
  const refuse = async () => { throw unavailable("NOTIFIER_UNAVAILABLE", "Messaging is not configured on this server yet."); };
  return { sendSms: refuse, sendEmail: refuse, driver, deliversExternally: false };
}
