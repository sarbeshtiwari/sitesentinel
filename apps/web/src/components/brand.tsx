"use client";
import { ShieldCheck } from "lucide-react";
import { AuthLayout, Card, CardContent, CardDescription, CardHeader, CardTitle } from "@wim/ui";
import Link from "next/link";
import { useConfig } from "@/lib/hooks";

export function BrandMark({ className = "" }: { className?: string }) {
  const { config } = useConfig();
  return (
    <span className={`inline-flex items-center gap-2 ${className}`}>
      {config.logoUrl && /^https:\/\//.test(config.logoUrl) ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img src={config.logoUrl} alt="" className="h-6 w-auto" />
      ) : (
        <ShieldCheck className="h-5 w-5 text-primary" aria-hidden />
      )}
      <span>{config.productName}</span>
    </span>
  );
}

export function AuthCard({ title, description, children, footer }: { title: string; description?: React.ReactNode; children: React.ReactNode; footer?: React.ReactNode }) {
  const { config } = useConfig();
  return (
    <AuthLayout
      brand={<Link href="/" className="rounded"><BrandMark /></Link>}
      footer={
        <>
          {footer}
          {(config.termsUrl || config.privacyUrl || config.supportEmail) && (
            <p className="mt-3 flex flex-wrap justify-center gap-3 text-xs">
              {config.termsUrl && <a className="hover:underline" href={config.termsUrl} rel="noopener noreferrer" target="_blank">Terms</a>}
              {config.privacyUrl && <a className="hover:underline" href={config.privacyUrl} rel="noopener noreferrer" target="_blank">Privacy</a>}
              {config.supportEmail && <a className="hover:underline" href={`mailto:${config.supportEmail}`}>Support</a>}
            </p>
          )}
        </>
      }
    >
      <Card>
        <CardHeader>
          <CardTitle>{title}</CardTitle>
          {description && <CardDescription>{description}</CardDescription>}
        </CardHeader>
        <CardContent>{children}</CardContent>
      </Card>
    </AuthLayout>
  );
}
