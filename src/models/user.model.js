import { isStaffRole } from "../config/permissions.js";

/**
 * Shape sent to the browser. `phone` mirrors `mobile` because the existing React code reads session.user.phone;
 * `isStaff` is a display hint for showing back-office links — the API never trusts it.
 */
export function toUserDto(row) {
  const roles = row.roles || [];
  return {
    id: row.id,
    name: row.full_name,
    email: row.email,
    mobile: row.mobile,
    phone: row.mobile,
    status: row.status,
    roles,
    permissions: row.permissions || [],
    isStaff: isStaffRole(roles),
    legacyId: row.legacy_id ?? null,
    emailVerified: !!row.email_verified_at,
    phoneVerified: !!row.mobile_verified_at,
    memberSince: row.created_at ? new Date(row.created_at).toISOString().slice(0, 10) : null,
  };
}

/** Compact shape for admin lists (no permission expansion). */
export function toUserSummaryDto(row) {
  return {
    id: row.id, name: row.full_name, email: row.email, mobile: row.mobile, status: row.status,
    roles: row.roles || [], lastLoginAt: row.last_login_at, createdAt: row.created_at, isDemo: row.is_demo,
  };
}

/** Fields of a user row that are safe to write to the audit log (never the password hash). */
export const auditView = (row) => ({ status: row.status, roles: row.roles, email: row.email, mobile: row.mobile });
