import { z } from "zod";

const uuid = z.string().uuid("Invalid id");
const sellerId = z.string().regex(/^[a-z0-9][a-z0-9-]{0,80}$/, "Invalid shop id");

export const idParams = z.object({ id: uuid });
export const sellerParams = z.object({ sellerId });

/** `clientCallId` makes a retry or double-tap of "Call" return the original call instead of ringing the shop twice. */
export const startBody = z.object({ sellerId, clientCallId: uuid });

export const endBody = z.object({ reason: z.enum(["hangup", "failed"]).default("hangup") });

export const streamQuery = z.object({ after: z.coerce.number().int().min(0).default(0) });

export const historyQuery = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(25),
  missedOnly: z.enum(["true", "false"]).default("false").transform((v) => v === "true"),
});

export const presenceBody = z.object({ accepting: z.boolean() });

const sdp = z.object({ type: z.enum(["offer", "answer"]), sdp: z.string().min(1).max(20_000) }).strict();
// An empty `candidate` is the standard end-of-candidates marker.
const ice = z.object({
  candidate: z.string().max(2_000),
  sdpMid: z.string().max(64).nullable().optional(),
  sdpMLineIndex: z.number().int().min(0).max(64).nullable().optional(),
  usernameFragment: z.string().max(128).nullable().optional(),
}).strict();

/** The payload shape must match `kind` (an "offer" can't carry an answer, nothing else can ride along). */
export const signalBody = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("offer"), payload: sdp.refine((p) => p.type === "offer", "Payload is not an offer") }),
  z.object({ kind: z.literal("answer"), payload: sdp.refine((p) => p.type === "answer", "Payload is not an answer") }),
  z.object({ kind: z.literal("ice"), payload: ice }),
]);
