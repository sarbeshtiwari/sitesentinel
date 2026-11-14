import { describe, expect, it } from "vitest";
import {
  SYSTEM_ROLES, OWNER_ONLY, ALL_PERMISSIONS, canAssignRole, canManageMember, canDefineCustomRole,
  wouldRemoveLastOwner, type Actor, type Permission,
  defaultSettings, parseSetting, resolveSettings, publicSettings, SETTINGS,
  ADMIN_ROLE_PERMISSIONS, adminHas,
} from "../src/index.js";

const actor = (key: keyof typeof SYSTEM_ROLES): Actor => ({ roleKey: key, permissions: new Set(SYSTEM_ROLES[key].permissions) });
const role = (key: keyof typeof SYSTEM_ROLES) => ({ key, permissions: SYSTEM_ROLES[key].permissions });

describe("system roles", () => {
  it("are strictly nested OWNER ⊃ ADMIN ⊃ MEMBER ⊃ VIEWER", () => {
    const o = new Set(SYSTEM_ROLES.OWNER.permissions);
    const a = new Set(SYSTEM_ROLES.ADMIN.permissions);
    const m = new Set(SYSTEM_ROLES.MEMBER.permissions);
    expect(SYSTEM_ROLES.ADMIN.permissions.every((p) => o.has(p))).toBe(true);
    expect(SYSTEM_ROLES.MEMBER.permissions.every((p) => a.has(p))).toBe(true);
    expect(SYSTEM_ROLES.VIEWER.permissions.every((p) => m.has(p))).toBe(true);
    expect(o.size).toBe(ALL_PERMISSIONS.length);
  });
  it("owner-only permissions belong to OWNER alone", () => {
    for (const p of OWNER_ONLY) {
      expect(SYSTEM_ROLES.ADMIN.permissions).not.toContain(p);
      expect(SYSTEM_ROLES.OWNER.permissions).toContain(p);
    }
  });
  it("viewer has no write permissions", () => {
    expect(SYSTEM_ROLES.VIEWER.permissions.filter((p) => /:(write|manage|delete|update|approve)/.test(p))).toEqual([]);
  });
});

describe("privilege escalation policy", () => {
  it("nobody can assign OWNER through role assignment", () => {
    expect(canAssignRole(actor("OWNER"), role("OWNER")).ok).toBe(false);
  });
  it("admin can assign ADMIN/MEMBER/VIEWER, member cannot assign anything", () => {
    expect(canAssignRole(actor("ADMIN"), role("ADMIN")).ok).toBe(true);
    expect(canAssignRole(actor("ADMIN"), role("VIEWER")).ok).toBe(true);
    expect(canAssignRole(actor("MEMBER"), role("VIEWER")).ok).toBe(false);
  });
  it("cannot assign a custom role carrying permissions the actor lacks", () => {
    const limited: Actor = { roleKey: "custom", permissions: new Set<Permission>(["member:manage", "org:read"]) };
    expect(canAssignRole(limited, { key: "x", permissions: ["org:read", "website:write"] }).ok).toBe(false);
    expect(canAssignRole(limited, { key: "x", permissions: ["org:read"] }).ok).toBe(true);
  });
  it("admin cannot manage an owner; nobody manages themselves", () => {
    expect(canManageMember(actor("ADMIN"), role("OWNER"), false).ok).toBe(false);
    expect(canManageMember(actor("OWNER"), role("OWNER"), false).ok).toBe(true);
    expect(canManageMember(actor("OWNER"), role("MEMBER"), true).ok).toBe(false);
  });
  it("custom roles: no owner-only permissions, subset of actor, non-empty", () => {
    expect(canDefineCustomRole(actor("OWNER"), ["billing:manage"]).ok).toBe(false);
    expect(canDefineCustomRole(actor("ADMIN"), ["website:read", "incident:write"]).ok).toBe(true);
    expect(canDefineCustomRole(actor("MEMBER"), ["website:read"]).ok).toBe(false); // no role:manage
    expect(canDefineCustomRole(actor("ADMIN"), []).ok).toBe(false);
  });
  it("last owner protection", () => {
    expect(wouldRemoveLastOwner(1, true)).toBe(true);
    expect(wouldRemoveLastOwner(2, true)).toBe(false);
    expect(wouldRemoveLastOwner(1, false)).toBe(false);
  });
});

describe("admin roles", () => {
  it("only SUPER_ADMIN can write settings or manage admins; auditor reads audit only", () => {
    for (const [r, perms] of Object.entries(ADMIN_ROLE_PERMISSIONS)) {
      if (r !== "SUPER_ADMIN") {
        expect(perms).not.toContain("admin:settings:write");
        expect(perms).not.toContain("admin:admins:manage");
        if (r !== "ADMIN_OPERATOR") expect(perms).not.toContain("admin:transfers:decide");
      }
    }
    expect(ADMIN_ROLE_PERMISSIONS.ADMIN_AUDITOR).toEqual(["admin:audit:read"]);
    expect(adminHas("SUPER_ADMIN", "admin:settings:write")).toBe(true);
  });
});

describe("settings registry", () => {
  it("defaults validate against their own schemas", () => {
    const d = defaultSettings() as Record<string, unknown>;
    for (const [k, def] of Object.entries(SETTINGS)) expect(def.schema.safeParse(d[k]).success, k).toBe(true);
    expect(d["branding.productName"]).toBe("SiteSentinel");
    expect(d["trial.days"]).toBe(30);
    expect(d["trial.requiresCard"]).toBe(false);
  });
  it("rejects invalid values and keeps defaults for invalid stored rows", () => {
    expect(() => parseSetting("auth.password.minLength", 6)).toThrow();
    const invalid: string[] = [];
    const s = resolveSettings([{ key: "trial.days", value: "lots" }, { key: "branding.productName", value: "Acme Watch" }, { key: "unknown", value: 1 }], (k) => invalid.push(k));
    expect(s["trial.days"]).toBe(30);
    expect(s["branding.productName"]).toBe("Acme Watch");
    expect(invalid).toEqual(["trial.days"]);
  });
  it("public settings never include non-public keys", () => {
    const pub = publicSettings(defaultSettings());
    expect(Object.keys(pub)).toContain("branding.productName");
    expect(Object.keys(pub)).not.toContain("billing.tax.sellerGstin");
    expect(Object.keys(pub)).not.toContain("auth.login.lockMinutes");
  });
});
