/** Super Admin roles → permissions (API_DOCUMENTATION.md §3). Separate from org RBAC by design. */
export const ADMIN_PERMISSIONS = [
  "admin:overview:read",
  "admin:customers:read",
  "admin:audit:read",
  "admin:settings:read",
  "admin:settings:write",
  "admin:admins:manage",
  "admin:transfers:decide",
  "admin:monitoring:read",
  "admin:monitoring:replay",
  // Phase 4H
  "admin:ops:alerts",          // acknowledge platform alerts
  "admin:usage:read",          // usage totals and reconciliation results (counts per organisation, no content)
  "admin:usage:adjust",        // correct usage counters (always with a reason, audited)
  "admin:settings:protected",  // change protected security policies (in addition to admin:settings:write)
] as const;

export type AdminPermission = (typeof ADMIN_PERMISSIONS)[number];
export type AdminRoleKey = "SUPER_ADMIN" | "ADMIN_OPERATOR" | "ADMIN_BILLING" | "ADMIN_SUPPORT" | "ADMIN_AUDITOR";

export const ADMIN_ROLE_PERMISSIONS: Record<AdminRoleKey, readonly AdminPermission[]> = {
  SUPER_ADMIN: ADMIN_PERMISSIONS,
  ADMIN_OPERATOR: ["admin:overview:read", "admin:customers:read", "admin:settings:read", "admin:transfers:decide", "admin:monitoring:read", "admin:monitoring:replay", "admin:ops:alerts", "admin:usage:read"],
  ADMIN_BILLING: ["admin:overview:read", "admin:customers:read", "admin:usage:read"],
  ADMIN_SUPPORT: ["admin:overview:read", "admin:customers:read", "admin:settings:read", "admin:monitoring:read"],
  ADMIN_AUDITOR: ["admin:audit:read"],
};

export function adminHas(role: AdminRoleKey, perm: AdminPermission): boolean {
  return ADMIN_ROLE_PERMISSIONS[role].includes(perm);
}
