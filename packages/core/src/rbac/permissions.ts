/**
 * Org-level permission catalog (API_DOCUMENTATION.md §1.4). The database
 * `permissions` / `role_permissions` tables are seeded from this file, and guards
 * check against the role's permissions loaded from the database, so custom roles
 * work without code changes.
 */
export const PERMISSIONS = {
  "org:read": "View organization details",
  "org:update": "Update organization settings",
  "org:delete": "Schedule or cancel organization deletion",
  "org:transfer_ownership": "Transfer organization ownership",
  "member:read": "View members",
  "member:manage": "Invite, remove and change member roles",
  "role:manage": "Create and edit custom roles",
  "website:read": "View websites",
  "website:write": "Create, update, pause and verify websites",
  "website:delete": "Delete websites",
  "monitoring:write": "Configure monitoring, pages, test cases and API endpoints",
  "secret:write": "Write credentials and authentication recipes",
  "journey:approve": "Approve submitting test journeys",
  "incident:read": "View incidents",
  "incident:write": "Transition and comment on incidents",
  "notification:manage": "Manage organization notification channels",
  "analytics:read": "View analytics",
  "report:create": "Generate reports",
  "billing:read": "View subscription and invoices",
  "billing:manage": "Change plans and payment methods",
  "audit:read": "View the organization audit log",
  "data:export": "Export all organization data",
} as const;

export type Permission = keyof typeof PERMISSIONS;
export const ALL_PERMISSIONS = Object.keys(PERMISSIONS) as Permission[];

export function isPermission(p: string): p is Permission {
  return Object.prototype.hasOwnProperty.call(PERMISSIONS, p);
}

/** Permissions that only an OWNER may hold; custom roles can never include them. */
export const OWNER_ONLY: readonly Permission[] = ["org:delete", "org:transfer_ownership", "billing:manage", "data:export"];

export type SystemRoleKey = "OWNER" | "ADMIN" | "MEMBER" | "VIEWER";

export const SYSTEM_ROLES: Record<SystemRoleKey, { name: string; description: string; permissions: Permission[] }> = {
  OWNER: {
    name: "Owner",
    description: "Full control, including billing, ownership transfer and deletion",
    permissions: ALL_PERMISSIONS,
  },
  ADMIN: {
    name: "Admin",
    description: "Manage members, websites, monitoring and incidents",
    permissions: ALL_PERMISSIONS.filter((p) => !OWNER_ONLY.includes(p)),
  },
  MEMBER: {
    name: "Member",
    description: "Manage websites, monitoring and incidents",
    permissions: [
      "org:read", "member:read", "website:read", "website:write", "monitoring:write", "secret:write",
      "incident:read", "incident:write", "analytics:read", "report:create",
    ],
  },
  VIEWER: {
    name: "Viewer",
    description: "Read-only access",
    permissions: ["org:read", "member:read", "website:read", "incident:read", "analytics:read", "report:create"],
  },
};

export const SYSTEM_ROLE_KEYS = Object.keys(SYSTEM_ROLES) as SystemRoleKey[];
