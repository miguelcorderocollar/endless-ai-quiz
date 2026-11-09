"use client";

import { watchOutboxRetries } from "@/lib/answers/outboxCore";

import { useEffect, useSyncExternalStore } from "react";
import { useConvexAuth, useMutation } from "convex/react";

import { api } from "../../convex/_generated/api";
import {
  drainOutbox,
  getOutboxServerSnapshot,
  getOutboxSnapshot,
  shouldReconcile,
  startOutboxSync,
  subscribeOutbox,
} from "@/lib/answers/outbox";
import { readProgress, updateProgress } from "@/lib/progress";
import {
  getNetworkServerSnapshot,
  getNetworkSnapshot,
  startNetworkListener,
  subscribeNetwork,
} from "@/lib/pwa/network";
import { readProfileCache } from "@/lib/quiz/bankCache";

/**
 * Renders nothing. Keeps the answer outbox (#17) draining for as long as the
 * app is open: on mount, when the network returns mid-session, and when the
 * auth state settles after a sign-in. A drain against an empty queue is a
 * no-op, so re-running is free.
 */
export function OutboxFlusher() {
  const { isAuthenticated } = useConvexAuth();
  const recordAnswer = useMutation(api.answers.answer);
  const network = useSyncExternalStore(
    subscribeNetwork,
    getNetworkSnapshot,
    getNetworkServerSnapshot,
  );

  useEffect(startNetworkListener, []);
  useEffect(startOutboxSync, []);

  useEffect(() => {
    if (!isAuthenticated || !network.online) return;
    const account = readProfileCache()?.handle ?? null;
    const flush = () => drainOutbox(recordAnswer, account).then(({ sent, lastRating, maxAt }) => {
      if (sent > 0 && lastRating !== null && shouldReconcile(account, maxAt)) {
        updateProgress({ ...readProgress(), rating: lastRating });
      }
    });
    const stop = watchOutboxRetries(subscribeOutbox, getOutboxSnapshot, flush);
    void flush();
    return stop;
  }, [isAuthenticated, network.online, recordAnswer]);

  return null;
}

/**
 * The difference between "playing" and "synced", in one label. Silent when
 * everything has landed; `offline` when the network is gone, `N unsynced`
 * when answers are parked in the outbox, both when they coincide. Rendered in
 * the masthead and the shell header, so every route carries it.
 */
export function SyncStatus() {
  useEffect(startNetworkListener, []);
  const network = useSyncExternalStore(
    subscribeNetwork,
    getNetworkSnapshot,
    getNetworkServerSnapshot,
  );
  const outbox = useSyncExternalStore(
    subscribeOutbox,
    getOutboxSnapshot,
    getOutboxServerSnapshot,
  );

  const unsynced = outbox.pending.length;
  if (network.online && unsynced === 0) return null;

  const parts: string[] = [];
  if (!network.online) parts.push("offline");
  if (unsynced > 0) parts.push(`${unsynced} unsynced`);

  return (
    <span className="label text-muted/70" role="status">
      {parts.join(" · ")}
    </span>
  );
}
