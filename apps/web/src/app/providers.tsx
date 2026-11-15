"use client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { applyStoredTheme, Toaster, useBrandColor } from "@wim/ui";
import { useEffect, useState } from "react";
import { ApiError } from "@/lib/api";
import { useConfig } from "@/lib/hooks";

function Branding() {
  const { config } = useConfig();
  useBrandColor(config.primaryColor);
  useEffect(() => {
    if (config.faviconUrl) {
      let link = document.querySelector<HTMLLinkElement>("link[rel=icon]");
      if (!link) { link = document.createElement("link"); link.rel = "icon"; document.head.appendChild(link); }
      link.href = config.faviconUrl;
    }
  }, [config.faviconUrl]);
  // React 19 hoists <title> into <head>; the product name comes from platform settings.
  return <title>{config.productName}</title>;
}

export function Providers({ children }: { children: React.ReactNode }) {
  const [client] = useState(
    () =>
      new QueryClient({
        defaultOptions: {
          queries: {
            retry: (count, e) => !(e instanceof ApiError && e.status >= 400 && e.status < 500) && count < 2,
            refetchOnWindowFocus: true, // returning to the tab shows current data
          },
        },
      }),
  );
  useEffect(() => applyStoredTheme(), []);
  return (
    <QueryClientProvider client={client}>
      <Branding />
      {children}
      <Toaster position="bottom-right" richColors closeButton />
    </QueryClientProvider>
  );
}
