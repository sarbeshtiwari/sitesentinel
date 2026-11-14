"use client";
import { useQuery } from "@tanstack/react-query";
import type { DataEnvelope, MeDto, OrgDto, PublicConfigDto } from "@wim/contracts";
import type { Permission } from "@wim/core";
import { useParams } from "next/navigation";
import { get } from "./api";

export const qk = {
  config: ["config"] as const,
  me: ["me"] as const,
  org: (id: string) => ["org", id] as const,
  members: (id: string) => ["org", id, "members"] as const,
  invitations: (id: string) => ["org", id, "invitations"] as const,
  roles: (id: string) => ["org", id, "roles"] as const,
  audit: (id: string) => ["org", id, "audit"] as const,
  sessions: ["sessions"] as const,
  activity: ["activity"] as const,
  myInvitations: ["me", "invitations"] as const,
  permissions: ["permissions"] as const,
};

export const FALLBACK_CONFIG: PublicConfigDto = {
  productName: "SiteSentinel", logoUrl: null, faviconUrl: null, primaryColor: "#4f46e5", supportEmail: null,
  termsUrl: null, privacyUrl: null, termsVersion: "", registration: "OPEN", passwordMinLength: 12, maintenanceMode: false,
};

export function useConfig() {
  const q = useQuery({
    queryKey: qk.config,
    queryFn: () => get<DataEnvelope<PublicConfigDto>>("/public/config", { noAuthRedirect: true }).then((r) => r.data),
    staleTime: 60_000,
  });
  return { ...q, config: q.data ?? FALLBACK_CONFIG };
}

export function useMe(opts: { noAuthRedirect?: boolean } = {}) {
  return useQuery({
    queryKey: qk.me,
    queryFn: () => get<DataEnvelope<MeDto>>("/me", opts).then((r) => r.data),
    staleTime: 30_000,
  });
}

export function useOrgId(): string {
  return useParams<{ orgId: string }>().orgId;
}

export function useOrg() {
  const orgId = useOrgId();
  const q = useQuery({
    queryKey: qk.org(orgId),
    queryFn: () => get<DataEnvelope<OrgDto>>(`/orgs/${orgId}`).then((r) => r.data),
    enabled: Boolean(orgId),
  });
  const can = (p: Permission) => Boolean(q.data?.myRole.permissions.includes(p));
  return { ...q, orgId, can };
}
