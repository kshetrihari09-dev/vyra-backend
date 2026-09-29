import { createHmac } from "node:crypto";
import { unavailable } from "../utils/errors.js";

/**
 * Delivery channel abstraction for OTPs, reset links and outbox messages. Drivers: console (dev only — logs the
 * message), disabled (refuses), webhook (signed POST to your SMS/email gateway).
 *
 *   sendSms({ to, text })
 *   sendEmail({ to, subject, text })
 */
export function createNotifier({ driver, logger, webhookUrl, webhookSecret, timeoutMs = 8000, fetchImpl = globalThis.fetch, clock = () => Date.now() }) {
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
      sendEmail: ({ to, subject, text }) => post({ channel: "email", to, subject, text }),
    };
  }
  if (driver === "console") {
    return {
      async sendSms({ to, text }) { logger.info("[notify:console] sms", { to, text }); },
      async sendEmail({ to, subject, text }) { logger.info("[notify:console] email", { to, subject, text }); },
    };
  }
  const refuse = async () => { throw unavailable("NOTIFIER_UNAVAILABLE", "Messaging is not configured on this server yet."); };
  return { sendSms: refuse, sendEmail: refuse };
}
