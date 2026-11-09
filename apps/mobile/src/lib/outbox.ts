import AsyncStorage from "@react-native-async-storage/async-storage";

import {
  appendQueued,
  EMPTY_OUTBOX,
  type OutboxState,
  type QueuedAnswer,
  type SendAnswer,
  resetReconcile,
  runDrain,
  sanitizeQueue,
  shouldReconcile,
  withoutSent,
} from "@shared/lib/answers/outboxCore";

/**
 * The native answer outbox: the AsyncStorage adapter over the shared core
 * (`src/lib/answers/outboxCore.ts`).
 *
 * The split is deliberate and it is the point. The rules the *server* depends
 * on — order, cap, sanitising, transient retries, per-account attribution,
 * `eventId` on every send — are in the core, imported, and the web app drains
 * through the same functions. What differs here is only the two things that
 * genuinely differ between a browser and a phone:
 *
 *   1. **Reads are async.** localStorage is synchronous, so the web adapter can
 *      hand `useSyncExternalStore` a value during render. AsyncStorage cannot,
 *      so the queue is an in-memory mirror that is *seeded once at startup* and
 *      written through on every change. Every mutation goes through `set`,
 *      which is the only place the mirror and the store can diverge, and it
 *      updates both.
 *
 *   2. **There is no cross-tab sync.** One app, one process. The web's
 *      `storage` listener has no native equivalent and needs none — a phone has
 *      one copy of this module.
 *
 * A write failure is swallowed on purpose, same as the web: the answer already
 * painted locally and the rating moved. Losing the queued copy costs a sync,
 * not the answer.
 */
const KEY = "endless-ai:answer-outbox:v1";

export { shouldReconcile, OUTBOX_CAP } from "@shared/lib/answers/outboxCore";
export type { QueuedAnswer, SendAnswer } from "@shared/lib/answers/outboxCore";

/**
 * Client-generated id. Not a UUID: `crypto.randomUUID` is not in Hermes, and
 * the only requirement is that it be unique per answer and stable across a
 * retry — the server dedupes on it and this value is written to disk with the
 * event, so it survives process death.
 */
export function newEventId(): string {
  const rand = () => Math.floor(Math.random() * 0x100000000).toString(16);
  return `${Date.now().toString(16)}-${rand()}-${rand()}`;
}

let current: OutboxState = EMPTY_OUTBOX;
const listeners = new Set<() => void>();

/**
 * Invalidates drains that are already in flight. `clearOutbox` bumps this;
 * every drain captures the value it started under and stops before its next
 * send once they differ.
 */
let generation = 0;

function notify(): void {
  for (const listener of listeners) listener();
}

function set(pending: readonly QueuedAnswer[], retryAt?: number): void {
  current = { pending, ...(retryAt === undefined ? {} : { retryAt }) };
  void AsyncStorage.setItem(KEY, JSON.stringify([...pending])).catch(() => {
    /* a full disk costs a sync, not the answer the player just gave */
  });
  notify();
}

export function subscribeOutbox(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/**
 * `useSyncExternalStore` snapshot. Stable between changes, so it is safe as a
 * cache slot: `current` is only replaced with a new object by `set`.
 */
export function getOutboxSnapshot(): OutboxState {
  return current;
}

/** Mirrors the web's server snapshot. */
export function getOutboxServerSnapshot(): OutboxState {
  return EMPTY_OUTBOX;
}

/**
 * Seeds the in-memory mirror from disk. Call once, before anything reads the
 * snapshot — the root layout does it next to `hydrateProgress`.
 *
 * Until this resolves the queue reads empty, so a drain in that window has
 * nothing to send. That is the safe direction: nothing is lost, and the
 * enqueue-then-drain path re-orders itself because every enqueue reads the
 * mirror, which by then is loaded.
 */
export async function hydrateOutbox(): Promise<void> {
  try {
    const raw = await AsyncStorage.getItem(KEY);
    const pending = raw ? sanitizeQueue(JSON.parse(raw)) : [];
    if (pending.length > 0) current = { pending };
  } catch {
    /* unreadable queue: start empty rather than wedge the quiz */
  }
  notify();
}

export function enqueueAnswer(event: QueuedAnswer): void {
  set(appendQueued(current.pending, event), current.retryAt);
}

/**
 * Empties the queue, on disk as well as in memory. Same contract as the web
 * adapter's: called after a progress reset is confirmed server-side, so events
 * queued between the enqueue and the wipe cannot drain afterwards and
 * resurrect the history that was just deleted.
 *
 * Bumps the drain generation and forgets the reconcile watermarks, for the
 * in-flight drain and the stale result it would otherwise apply.
 */
export function clearOutbox(): void {
  generation += 1;
  resetReconcile();
  set([]);
}

/**
 * Sends the queue for the given account and reports how many left the device,
 * the server's rating after the last one, and the newest record time sent, so
 * the caller can reconcile the local Elo to truth.
 */
export async function drainOutbox(
  send: SendAnswer,
  account: string | null,
): Promise<{ sent: number; lastRating: number | null; maxAt: number | null }> {
  const gen = generation;
  const { sent, lastRating, maxAt, settledIds, retryAfter } = await runDrain(
    current.pending,
    send,
    account,
    () => gen === generation,
  );
  if (gen === generation) {
    const pending = withoutSent(current.pending, settledIds);
    const retryAt = retryAfter === undefined ? undefined : Date.now() + retryAfter;
    if (pending.length !== current.pending.length || current.retryAt !== retryAt) set(pending, retryAt);
  }
  return { sent, lastRating, maxAt };
}
