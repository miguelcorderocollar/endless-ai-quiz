import { watchOutboxRetries } from "@shared/lib/answers/outboxCore";
import { useConvexAuth, useQuery } from "convex/react";
import { useEffect, useRef, useSyncExternalStore } from "react";
import { StyleSheet, Text } from "react-native";

import { answer as answerRef, me as meRef } from "@/lib/api";
import { syncOnSignIn } from "@/lib/account";
import { convexClient } from "@/lib/backend";
import {
  getNetworkServerSnapshot,
  getNetworkSnapshot,
  startNetworkListener,
  subscribeNetwork,
} from "@/lib/network";
import {
  drainOutbox,
  getOutboxServerSnapshot,
  getOutboxSnapshot,
  shouldReconcile,
  subscribeOutbox,
} from "@/lib/outbox";
import { readProfileCache } from "@/lib/profileCache";
import { getProgress, updateProgress } from "@/lib/progress";
import { label } from "@/theme";

/**
 * The native counterpart of `src/components/SyncStatus.tsx`: the same two
 * exports for the same two reasons, and the same strings, so the two apps say
 * the same thing about the same state.
 *
 * `OutboxFlusher` renders nothing and keeps the outbox draining for as long as
 * the app is open: on mount, when the network returns mid-session, and when the
 * auth state settles after a sign-in. It lives in the root layout rather than a
 * screen, which is the one structural difference from the web — a phone moves
 * between four screens and the queue has to survive all of them, where the web
 * mounts a flusher per route. A drain against an empty queue is a no-op, so
 * re-running is free.
 */
export function OutboxFlusher() {
  const { isAuthenticated } = useConvexAuth();
  const client = convexClient();
  const network = useSyncExternalStore(
    subscribeNetwork,
    getNetworkSnapshot,
    getNetworkServerSnapshot,
  );

  useEffect(() => {
    startNetworkListener();
  }, []);

  useEffect(() => {
    if (!isAuthenticated || !network.online || !client) return;
    const account = readProfileCache()?.handle ?? null;
    const flush = () => drainOutbox((args) => client.mutation(answerRef, args), account).then(
      ({ sent, lastRating, maxAt }) => {
        if (sent > 0 && lastRating !== null && shouldReconcile(account, maxAt)) {
          updateProgress({ ...getProgress(), rating: lastRating });
        }
      },
    );
    const stop = watchOutboxRetries(subscribeOutbox, getOutboxSnapshot, flush);
    void flush();
    return stop;
  }, [isAuthenticated, network.online, client]);

  return null;
}

/**
 * Runs `syncOnSignIn` once per sign-in, for the lifetime of the app. It lives
 * here, next to `OutboxFlusher`, for the same reason: a phone moves between
 * four screens, and a claim that lived on one of them would miss a session
 * restored straight into another — a cold start deep-linking to `/profile`
 * with a stored session mounts no quiz screen, so a quiz-screen effect never
 * fires and the device never reconciles. Mounted once in the root layout, it
 * fires on every auth transition wherever the session lands.
 *
 * Keyed on the identity handle, not just the boolean: signing in as B while
 * A's session is live keeps `isAuthenticated` true, so a boolean latch would
 * never refire and the device would show A's totals under B's name. Waiting
 * for the identity to resolve first also skips the claim entirely while
 * offline, which the old latch could not do — a doomed mutation is worse than
 * none, and the flusher owns the reconnect.
 */
export function ClaimOnSignIn() {
  const { isAuthenticated } = useConvexAuth();
  const client = convexClient();
  const identity = useQuery(meRef, isAuthenticated ? {} : "skip");
  const claimedFor = useRef<string | null | undefined>(undefined);

  useEffect(() => {
    if (!isAuthenticated || !client) {
      claimedFor.current = undefined;
      return;
    }
    if (identity === undefined) return;
    const handle = identity?.handle ?? null;
    if (claimedFor.current === handle) return;
    claimedFor.current = handle;
    void syncOnSignIn(client);
  }, [isAuthenticated, client, identity]);

  return null;
}

/**
 * The difference between "playing" and "synced", in one label. Silent when
 * everything has landed; `offline` when the network is gone, `N unsynced` when
 * answers are parked in the outbox, both when they coincide.
 */
export function SyncStatus() {
  useEffect(() => {
    startNetworkListener();
  }, []);
  const online = useSyncExternalStore(
    subscribeNetwork,
    getNetworkSnapshot,
    getNetworkServerSnapshot,
  ).online;
  const unsynced = useSyncExternalStore(
    subscribeOutbox,
    getOutboxSnapshot,
    getOutboxServerSnapshot,
  ).pending.length;

  if (online && unsynced === 0) return null;

  const parts: string[] = [];
  if (!online) parts.push("offline");
  if (unsynced > 0) parts.push(`${unsynced} unsynced`);

  return (
    <Text
      style={styles.chip}
      accessibilityRole="text"
      accessibilityLabel={parts.join(", ")}
    >
      {parts.join(" · ")}
    </Text>
  );
}

const styles = StyleSheet.create({
  // `text-muted/70` on the web, which is this alpha over ink.
  chip: { ...label, color: "rgba(111,117,128,0.7)" },
});
