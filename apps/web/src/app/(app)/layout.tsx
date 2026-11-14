"use client";
import { CustomerShell } from "@/components/app-shell";

export default function AppLayout({ children }: { children: React.ReactNode }) {
  return <CustomerShell>{children}</CustomerShell>;
}
