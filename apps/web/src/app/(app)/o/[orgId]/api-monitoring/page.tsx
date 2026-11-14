"use client";
import { EmptyState, PageHeader } from "@wim/ui";
import { Webhook } from "lucide-react";

export default function Page() {
  return (
    <>
      <PageHeader title="API monitoring" description="Scheduled checks of your API endpoints with assertions." />
      <EmptyState icon={<Webhook />} title="Available in a later phase" description="This section isn't released yet. It will show real monitoring data only — nothing here is simulated." />
    </>
  );
}
