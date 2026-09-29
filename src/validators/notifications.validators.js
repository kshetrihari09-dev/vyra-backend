import { z } from "zod";

export const idParams = z.object({ id: z.string().uuid() });
export const listQuery = z.object({
  unread: z.enum(["true", "false"]).optional().transform((v) => v === "true"),
  limit: z.coerce.number().int().min(1).max(100).default(30),
  before: z.string().datetime({ offset: true }).optional(),
});
export const prefsBody = z.object({ email: z.boolean().optional(), sms: z.boolean().optional() })
  .refine((b) => b.email !== undefined || b.sms !== undefined, "Nothing to update");

export const auditQuery = z.object({
  entityType: z.string().trim().max(60).optional(),
  entityId: z.string().trim().max(80).optional(),
  action: z.string().trim().max(80).optional(),
  actionPrefix: z.string().trim().max(60).optional(),
  actorUserId: z.string().uuid().optional(),
  from: z.string().datetime({ offset: true }).optional(),
  to: z.string().datetime({ offset: true }).optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(25),
});
