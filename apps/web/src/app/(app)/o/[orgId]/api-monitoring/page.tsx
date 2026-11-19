"use client";
import { EmptyState, PageHeader } from "@wim/ui";
import { Webhook } from "lucide-react";

export default function Page() {
  return (
    <>
      <PageHeader title="API monitoring" description="Check that your APIs return the right status, fast enough, with the expected response." />
      <EmptyState icon={<Webhook />} title="Not released yet" description="API monitoring is planned for a later release. When it ships, this page will show real monitoring data only — nothing here is simulated." />
    </>
  );
}
