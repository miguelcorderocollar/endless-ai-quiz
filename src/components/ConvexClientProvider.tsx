"use client";

import { ConvexAuthProvider } from "@convex-dev/auth/react";
import { ConvexReactClient } from "convex/react";
import { useMemo } from "react";

import { AccountLifecycle } from "./AccountLifecycle";
import { Shell } from "./QuizFromConvex";

// Module-level singleton (#31): one client across client-side navigations so
// the Convex query cache survives quiz <-> profile <-> categories moves.
// A per-layout useMemo(new ConvexReactClient) recreates the client on every
// full reload; combined with <a href> nav that meant refetch + skeleton each
// screen change. With next/link nav this instance (and its cache) persists.
let cachedClient: ConvexReactClient | null = null;
let cachedUrl: string | null = null;

function getClient(url: string): ConvexReactClient {
  if (cachedClient && cachedUrl === url) return cachedClient;
  cachedClient = new ConvexReactClient(url);
  cachedUrl = url;
  return cachedClient;
}

export function ConvexClientProvider({ children }: { children: React.ReactNode }) {
  const url = process.env.NEXT_PUBLIC_CONVEX_URL;
  const client = useMemo(() => (url ? getClient(url) : null), [url]);

  if (!client) {
    return (
      <Shell>
        <main className="flex flex-1 flex-col pt-14">
          <p className="label text-muted">backend not configured</p>
          <h1 className="mt-3 font-display text-3xl">No Convex URL</h1>
          <p className="mt-4 max-w-sm text-sm leading-relaxed text-muted">
            Set <span className="font-mono">NEXT_PUBLIC_CONVEX_URL</span> by running{" "}
            <span className="font-mono">npx convex dev</span>, then reload. See{" "}
            <span className="font-mono">docs/deployment.md</span>.
          </p>
        </main>
      </Shell>
    );
  }
  return <ConvexAuthProvider client={client}><AccountLifecycle />{children}</ConvexAuthProvider>;
}
