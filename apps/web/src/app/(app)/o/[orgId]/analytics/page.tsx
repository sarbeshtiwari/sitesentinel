import { redirect } from "next/navigation";

/** Analytics live on each website's Availability tab and the monitoring overview (Phase 4F). */
export default async function Page({ params }: { params: Promise<{ orgId: string }> }) {
  const { orgId } = await params;
  redirect(`/o/${orgId}/overview`);
}
