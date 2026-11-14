import { OWNER_ONLY, type Permission } from "./permissions.js";

/**
 * Privilege-escalation rules. These are pure functions so the API, tests and
 * (later) the admin panel apply identical logic.
 */

export interface Actor {
  roleKey: string;
  permissions: ReadonlySet<Permission>;
}

export interface RoleShape {
  key: string;
  permissions: readonly Permission[];
}

export type PolicyDecision = { ok: true } | { ok: false; reason: string };

const allow: PolicyDecision = { ok: true };
const deny = (reason: string): PolicyDecision => ({ ok: false, reason });

function subset(perms: readonly Permission[], of: ReadonlySet<Permission>): boolean {
  return perms.every((p) => of.has(p));
}

/** Can `actor` assign `role` to someone (invite with it, or change a member to it)? */
export function canAssignRole(actor: Actor, role: RoleShape): PolicyDecision {
  if (!actor.permissions.has("member:manage")) return deny("Missing member:manage");
  if (role.key === "OWNER") return deny("Ownership is assigned only through ownership transfer");
  if (!subset(role.permissions, actor.permissions)) return deny("Cannot grant permissions you do not hold");
  return allow;
}

/** Can `actor` change or remove a member who currently holds `targetRole`? */
export function canManageMember(actor: Actor, targetRole: RoleShape, isSelf: boolean): PolicyDecision {
  if (!actor.permissions.has("member:manage")) return deny("Missing member:manage");
  if (isSelf) return deny("Use 'leave organization' to remove yourself; you cannot change your own role");
  if (targetRole.key === "OWNER" && actor.roleKey !== "OWNER") return deny("Only an owner can manage another owner");
  if (!subset(targetRole.permissions, actor.permissions)) return deny("Target member holds permissions you do not hold");
  return allow;
}

/** Validate a custom role definition created or edited by `actor`. */
export function canDefineCustomRole(actor: Actor, permissions: readonly Permission[]): PolicyDecision {
  if (!actor.permissions.has("role:manage")) return deny("Missing role:manage");
  if (permissions.length === 0) return deny("A role needs at least one permission");
  const ownerOnly = permissions.filter((p) => OWNER_ONLY.includes(p));
  if (ownerOnly.length) return deny(`Owner-only permissions cannot be granted to custom roles: ${ownerOnly.join(", ")}`);
  if (!subset(permissions, actor.permissions)) return deny("Cannot grant permissions you do not hold");
  return allow;
}

/** An organization must always keep at least one owner. */
export function wouldRemoveLastOwner(ownerCount: number, targetIsOwner: boolean): boolean {
  return targetIsOwner && ownerCount <= 1;
}
