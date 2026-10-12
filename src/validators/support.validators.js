import { z } from "zod";

export const MAX_MESSAGE_CHARS = 2000;

/** Plain text only: CRLF normalised, control / zero-width characters dropped (newlines and tabs kept), blank-line runs collapsed. */
export const cleanText = (raw) => String(raw)
  .replace(/\r\n?/g, "\n")
  // eslint-disable-next-line no-control-regex
  .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F\u200B-\u200F\u202A-\u202E\u2060\uFEFF]/g, "")
  .replace(/\n{3,}/g, "\n\n")
  .trim();

const messageText = z.string({ required_error: "Write a message first", invalid_type_error: "Message must be text" })
  .transform(cleanText)
  .pipe(z.string().min(1, "Write a message first").max(MAX_MESSAGE_CHARS, `Keep it under ${MAX_MESSAGE_CHARS} characters`));

const uuid = z.string().uuid("Invalid id");
const productId = z.string().regex(/^[a-z0-9][a-z0-9-]{0,80}$/, "Invalid product id");

const refs = {
  orderId: uuid.optional(),
  productId: productId.optional(),
  prescriptionId: uuid.optional(),
};

export const idParams = z.object({ id: uuid });

export const contactQuery = z.object({ branchId: z.string().regex(/^[a-z0-9][a-z0-9-]{0,62}$/).optional() });

/** Live-chat message. `clientMessageId` makes a retry or double-tap idempotent. */
export const sendBody = z.object({ body: messageText, clientMessageId: uuid, ...refs });

/** The "message a pharmacist / contact support" form. `clientRequestId` makes retries and double submissions idempotent. */
export const TOPICS = ["pharmacist", "order", "payment", "delivery", "product", "return", "contact"];
export const formBody = z.object({ topic: z.enum(TOPICS), body: messageText, clientRequestId: uuid, ...refs });

const seq = z.coerce.number().int().min(0);
export const historyQuery = z.object({ before: seq.optional(), limit: z.coerce.number().int().min(1).max(100).default(50) });
export const streamQuery = z.object({ after: seq.default(0) });

export const replyBody = z.object({ body: messageText, clientMessageId: uuid });
export const inboxQuery = z.object({
  status: z.enum(["open", "resolved", "all"]).default("open"),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(50).default(25),
});
export const availabilityBody = z.object({ available: z.boolean() });
