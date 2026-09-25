import { z } from "zod";

/** Same rules as the storefront's utils/validation.js so the server never disagrees with the form. */
export const mobile = z.string().trim().regex(/^9[678]\d{8}$/, "Enter a valid mobile number (98XXXXXXXX)");

export const password = z.string()
  .min(8, "Password needs at least 8 characters")
  .max(128, "Password must be 128 characters or fewer")
  .regex(/[A-Za-z]/, "Password needs at least one letter")
  .regex(/[0-9]/, "Password needs at least one number");

/** Optional email: empty string is treated as "not provided". */
export const optionalEmail = z.preprocess(
  (v) => (typeof v === "string" && v.trim() === "" ? undefined : v),
  z.string().trim().toLowerCase().email("Enter a valid email address").max(254).optional(),
);

export const uuid = z.string().uuid();

export const pagination = {
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(25),
};
