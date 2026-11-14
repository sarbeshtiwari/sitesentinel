"use client";
import { Spinner } from "@wim/ui";
import { useRouter } from "next/navigation";
import { useEffect } from "react";
import { useMe } from "@/lib/hooks";

export default function Home() {
  const me = useMe();
  const router = useRouter();
  useEffect(() => {
    if (!me.data) return;
    router.replace(me.data.orgs[0] ? `/o/${me.data.orgs[0].id}/overview` : "/onboarding");
  }, [me.data, router]);
  return <div className="flex min-h-dvh items-center justify-center"><Spinner /></div>;
}
