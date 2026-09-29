import { z } from "zod";
import { pagination } from "./common.js";

export const idParams = z.object({ id: z.string().min(1).max(80) });

export const listQuery = z.object({
  status: z.enum(["pending", "active", "suspended", "rejected"]).optional(),
  q: z.string().trim().max(150).optional(),
  ...pagination,
});

export const statusBody = z.object({ status: z.enum(["pending", "active", "suspended", "rejected"]) });
export const payoutMethodLabelBody = z.object({ label: z.string().trim().min(1).max(120) });
