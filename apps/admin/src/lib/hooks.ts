"use client";
import { useQuery } from "@tanstack/react-query";
import type { AdminMeDto, AdminSettingDto, DataEnvelope } from "@wim/contracts";
import { get } from "./api";

export const qk = {
  me: ["admin-me"] as const,
  overview: ["overview"] as const,
  customers: (q: string) => ["customers", q] as const,
  audit: (stream: string) => ["audit", stream] as const,
  settings: ["settings"] as const,
  websiteStats: ["website-stats"] as const,
  transfers: ["domain-transfers"] as const,
};

export function useAdminMe() {
  const q = useQuery({ queryKey: qk.me, queryFn: () => get<DataEnvelope<AdminMeDto>>("/me").then((r) => r.data), staleTime: 60_000 });
  const can = (p: string) => Boolean(q.data?.permissions.includes(p));
  return { ...q, can };
}

/** Product name from platform settings (admins with settings access); generic label otherwise. */
export function useProductName(enabled: boolean) {
  const q = useQuery({
    queryKey: qk.settings,
    queryFn: () => get<DataEnvelope<AdminSettingDto[]>>("/settings").then((r) => r.data),
    enabled,
    staleTime: 60_000,
  });
  const v = q.data?.find((s) => s.key === "branding.productName")?.value;
  const color = q.data?.find((s) => s.key === "branding.primaryColor")?.value;
  return { name: typeof v === "string" ? v : null, color: typeof color === "string" ? color : undefined };
}
