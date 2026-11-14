"use client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { applyStoredTheme, Toaster } from "@wim/ui";
import { useEffect, useState } from "react";
import { ApiError } from "@/lib/api";



export function Providers({ children }: { children: React.ReactNode }) {
  const [client] = useState(
    () =>
      new QueryClient({
        defaultOptions: {
          queries: {
            retry: (count, e) => !(e instanceof ApiError && e.status >= 400 && e.status < 500) && count < 2,
            refetchOnWindowFocus: false,
          },
        },
      }),
  );
  useEffect(() => applyStoredTheme(), []);
  return (
    <QueryClientProvider client={client}>
      {children}
      <Toaster position="bottom-right" richColors closeButton />
    </QueryClientProvider>
  );
}
