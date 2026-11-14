"use client";
import { Alert, Badge, Button, buttonVariants, Card, DropdownItem, DropdownMenu, EmptyState, PageHeader, Skeleton, Table, TBody, TD, TH, THead, TR } from "@wim/ui";
import { ArrowLeftRight, Globe, MoreHorizontal, Plus } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { errorMessage } from "@/lib/api";
import { useOrg } from "@/lib/hooks";
import { INSTALL_STATE, relative, TRIAL_OUTCOME, useWebsites, VERIFICATION_STATE, fmtDate } from "@/lib/websites";

export default function WebsitesPage() {
  const { orgId, can } = useOrg();
  const router = useRouter();
  const sites = useWebsites(orgId);
  const write = can("website:write");
  const base = `/o/${orgId}/websites`;

  return (
    <>
      <PageHeader
        title="Websites"
        description="Register websites, prove ownership and install the monitoring script."
        actions={
          <div className="flex gap-2">
            <Link href={`${base}/transfers`} className={buttonVariants({ variant: "outline" })}><ArrowLeftRight className="h-4 w-4" /> Transfers</Link>
            {write && <Link href={`${base}/new`} className={buttonVariants()}><Plus className="h-4 w-4" /> Add website</Link>}
          </div>
        }
      />
      {sites.isLoading ? <Skeleton className="h-40" /> : sites.isError ? <Alert tone="danger" title={errorMessage(sites.error)} /> : !sites.data?.length ? (
        <EmptyState
          icon={<Globe />}
          title="No websites yet"
          description="Add a website, verify that you own its domain, then install the monitoring script. Monitoring checks start in a later release."
          action={write ? <Link href={`${base}/new`} className={buttonVariants()}><Plus className="h-4 w-4" /> Add website</Link> : undefined}
        />
      ) : (
        <Card className="overflow-hidden">
          <Table>
            <THead>
              <TR><TH>Website</TH><TH>Verification</TH><TH>SDK</TH><TH className="hidden md:table-cell">Trial</TH><TH className="hidden lg:table-cell">Created</TH><TH className="hidden lg:table-cell">Last activity</TH><TH><span className="sr-only">Actions</span></TH></TR>
            </THead>
            <TBody>
              {sites.data.map((w) => {
                const v = VERIFICATION_STATE[w.verification] ?? { label: w.verification, tone: "neutral" as const };
                const i = INSTALL_STATE[w.installation];
                return (
                  <TR key={w.id}>
                    <TD>
                      <Link href={`${base}/${w.id}`} className="font-medium hover:underline">{w.name}</Link>
                      <div className="text-xs text-muted-foreground">{w.displayHost}</div>
                    </TD>
                    <TD><Badge tone={v.tone}>{v.label}</Badge></TD>
                    <TD><Badge tone={i.tone}>{i.label}</Badge></TD>
                    <TD className="hidden max-w-56 text-xs text-muted-foreground md:table-cell">{w.trialOutcome ? TRIAL_OUTCOME[w.trialOutcome] ?? w.trialOutcome : "—"}</TD>
                    <TD className="hidden text-muted-foreground lg:table-cell">{fmtDate(w.createdAt)}</TD>
                    <TD className="hidden text-muted-foreground lg:table-cell">{relative(w.lastActivityAt)}</TD>
                    <TD className="text-right">
                      <DropdownMenu label={`Actions for ${w.name}`} trigger={<Button size="icon" variant="ghost" aria-label={`Actions for ${w.name}`}><MoreHorizontal className="h-4 w-4" /></Button>}>
                        <DropdownItem onClick={() => router.push(`${base}/${w.id}`)}>Overview</DropdownItem>
                        <DropdownItem onClick={() => router.push(`${base}/${w.id}?tab=verification`)}>Verification</DropdownItem>
                        <DropdownItem onClick={() => router.push(`${base}/${w.id}?tab=installation`)}>Installation</DropdownItem>
                        {write && <DropdownItem onClick={() => router.push(`${base}/${w.id}?tab=settings`)}>Settings</DropdownItem>}
                      </DropdownMenu>
                    </TD>
                  </TR>
                );
              })}
            </TBody>
          </Table>
        </Card>
      )}
    </>
  );
}
