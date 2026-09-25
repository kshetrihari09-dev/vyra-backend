import { z } from "zod";
import { mobile, optionalEmail, password, pagination, uuid } from "./common.js";
import { ROLE_KEYS } from "../config/permissions.js";

const identifier = z.string().trim().min(1, "Enter your mobile number or email").max(254);

export const registerStart = z.object({
  name: z.string().trim().min(1, "Enter your full name").max(100),
  mobile,
  email: optionalEmail,
  password,
}).strict();

export const registerVerify = z.object({
  challengeId: uuid,
  code: z.string().trim().regex(/^\d{4}$/, "Enter the 4-digit code"),
}).strict();

export const login = z.object({
  identifier,
  password: z.string().min(1, "Enter your password").max(128),
}).strict();

export const forgotPassword = z.object({ identifier }).strict();

export const resetPassword = z.object({
  token: z.string().min(20).max(200),
  password,
}).strict();

export const changePassword = z.object({
  currentPassword: z.string().min(1).max(128),
  newPassword: password,
}).strict();

// ---- admin: users & roles
export const listUsersQuery = z.object({
  q: z.string().trim().max(100).optional(),
  status: z.enum(["active", "suspended", "deactivated"]).optional(),
  role: z.enum(ROLE_KEYS).optional(),
  ...pagination,
});
export const userIdParams = z.object({ id: uuid });
export const setStatusBody = z.object({
  status: z.enum(["active", "suspended", "deactivated"]),
  reason: z.string().trim().max(500).optional(),
}).strict();
export const setRolesBody = z.object({
  roles: z.array(z.string().regex(/^[a-z][a-z_]{1,31}$/)).min(1, "Assign at least one role").max(10),
}).strict();
