import { z } from "zod";

export const orderIdParams = z.object({ id: z.string().uuid() });
export const paymentIdParams = z.object({ id: z.string().uuid() });
export const refundIdParams = z.object({ id: z.string().uuid() });

export const refundRequestBody = z.object({
  amount: z.number().positive().max(10_000_000).optional(), // omitted = refund the full remaining balance
  reason: z.string().trim().min(1, "Tell us why you're requesting a refund").max(500),
});

export const refundDecisionBody = z.object({
  decision: z.enum(["approve", "reject"]),
  note: z.string().trim().max(500).nullable().optional(),
});

export const refundListQuery = z.object({
  status: z.enum(["pending", "approved", "rejected", "completed"]).optional(),
});

/** Provider name comes from the URL segment, not the body, so it can never disagree with which secret verified it. */
export const webhookProviderParams = z.object({ provider: z.enum(["cod", "manual"]) });
