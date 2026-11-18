"use client";
import type { WebsiteSummaryDto } from "@wim/contracts";
import { Badge, buttonVariants, DropdownItem, DropdownMenu, EmptyState, ErrorState, PageHeader, Skeleton, Table, TBody, TD, TH, THead, TR } from "@wim/ui";
import { ArrowLeftRight, Globe, MoreHorizontal, Plus } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { errorMessage } from "@/lib/api";
import { Section } from "@/components/monitoring";
import { useOrg } from "@/lib/hooks";
import { INSTALL_STATE, relative, TRIAL_OUTCOME, useWebsites, VERIFICATION_STATE, fmtDate } from "@/lib/websites";

function RowActions({ w, base, write }: { w: WebsiteSummaryDto; base: string; write: boolean }) {
  const router = useRouter();
  return (
    <DropdownMenu label={`Actions for ${w.name}`} triggerClassName={buttonVariants({ variant: "ghost", size: "icon" })} trigger={<MoreHorizontal className="h-4 w-4" aria-hidden />}>
      <DropdownItem onClick={() => router.push(`${base}/${w.id}`)}>Overview</DropdownItem>
      <DropdownItem onClick={() => router.push(`${base}/${w.id}?tab=verification`)}>Verification</DropdownItem>
      <DropdownItem onClick={() => router.push(`${base}/${w.id}?tab=installation`)}>Installation</DropdownItem>
      {write && <DropdownItem onClick={() => router.push(`${base}/${w.id}?tab=settings`)}>Settings</DropdownItem>}
    </DropdownMenu>
  );
}

export default function WebsitesPage() {
  const { orgId, can } = useOrg();
  const sites = useWebsites(orgId);
  const write = can("website:write");
  const base = `/o/${orgId}/websites`;

  return (
    <>
      <PageHeader
        title="Websites"
        description="Register websites, prove ownership and install the monitoring script."
        actions={<>
          <Link href={`${base}/transfers`} className={buttonVariants({ variant: "outline", size: "sm" })}><ArrowLeftRight /> Transfers</Link>
          {write && <Link href={`${base}/new`} className={buttonVariants({ size: "sm" })}><Plus /> Add website</Link>}
        </>}
      />
      {sites.isLoading ? <div role="status" aria-label="Loading"><Skeleton className="h-64" /></div> : sites.isError ? <ErrorState title="Couldn't load websites" description={errorMessage(sites.error)} onRetry={() => void sites.refetch()} /> : !sites.data?.length ? (
        <EmptyState
          icon={<Globe />}
          title="No websites yet"
          description="Add a website, verify that you own its domain, then install the monitoring script. Monitoring checks start in a later release."
          action={write ? <Link href={`${base}/new`} className={buttonVariants()}><Plus className="h-4 w-4" /> Add website</Link> : undefined}
        />
      ) : (
        <Section title="All websites" description={`${sites.data.length} website${sites.data.length === 1 ? "" : "s"} in this organization`} icon={<Globe />} flush>
          {/* Cards on small screens */}
          <ul className="divide-y divide-border md:hidden">
            {sites.data.map((w) => {
              const v = VERIFICATION_STATE[w.verification] ?? { label: w.verification, tone: "neutral" as const };
              const i = INSTALL_STATE[w.installation];
              return (
                <li key={w.id} className="flex items-start gap-2 px-4 py-3">
                  <div className="min-w-0 flex-1">
                    <Link href={`${base}/${w.id}`} className="block truncate font-medium hover:text-primary">{w.name}</Link>
                    <p className="truncate text-xs text-muted-foreground">{w.displayHost} · {relative(w.lastActivityAt)}</p>
                    <div className="mt-2 flex flex-wrap gap-1.5"><Badge tone={v.tone}>{v.label}</Badge><Badge tone={i.tone}>{i.label}</Badge></div>
                  </div>
                  <RowActions w={w} base={base} write={write} />
                </li>
              );
            })}
          </ul>
          {/* Table from md up */}
          <div className="hidden md:block">
            <Table>
              <THead>
                <TR><TH>Website</TH><TH>Verification</TH><TH>SDK</TH><TH className="hidden lg:table-cell">Trial</TH><TH className="hidden lg:table-cell">Created</TH><TH className="hidden xl:table-cell">Last activity</TH><TH><span className="sr-only">Actions</span></TH></TR>
              </THead>
              <TBody>
                {sites.data.map((w) => {
                  const v = VERIFICATION_STATE[w.verification] ?? { label: w.verification, tone: "neutral" as const };
                  const i = INSTALL_STATE[w.installation];
                  return (
                    <TR key={w.id}>
                      <TD className="max-w-72">
                        <div className="flex items-center gap-3">
                          <span aria-hidden className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md bg-sunken text-muted-foreground ring-1 ring-border"><Globe className="h-4 w-4" /></span>
                          <div className="min-w-0">
                            <Link href={`${base}/${w.id}`} className="block truncate font-medium hover:text-primary">{w.name}</Link>
                            <div className="truncate text-xs text-muted-foreground">{w.displayHost}</div>
                          </div>
                        </div>
                      </TD>
                      <TD><Badge tone={v.tone}>{v.label}</Badge></TD>
                      <TD><Badge tone={i.tone}>{i.label}</Badge></TD>
                      <TD className="hidden max-w-56 text-xs text-muted-foreground lg:table-cell">{w.trialOutcome ? TRIAL_OUTCOME[w.trialOutcome] ?? w.trialOutcome : "—"}</TD>
                      <TD className="hidden whitespace-nowrap text-muted-foreground tabular-nums lg:table-cell">{fmtDate(w.createdAt)}</TD>
                      <TD className="hidden whitespace-nowrap text-muted-foreground xl:table-cell">{relative(w.lastActivityAt)}</TD>
                      <TD className="text-right"><RowActions w={w} base={base} write={write} /></TD>
                    </TR>
                  );
                })}
              </TBody>
            </Table>
          </div>
        </Section>
      )}
    </>
  );
}
