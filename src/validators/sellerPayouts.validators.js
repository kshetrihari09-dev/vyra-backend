import { z } from "zod";

export const sellerIdParams = z.object({ sellerId: z.string().min(1).max(80) });
export const payoutIdParams = z.object({ id: z.string().uuid() });

export const requestBody = z.object({
  amount: z.number().positive().max(10_000_000).optional(), // omitted = the full available balance
  note: z.string().trim().max(500).optional(),
});

export const listQuery = z.object({ status: z.enum(["requested", "approved", "rejected", "paid"]).optional() });
export const decisionBody = z.object({ decision: z.enum(["approve", "reject"]), note: z.string().trim().max(500).optional() });
