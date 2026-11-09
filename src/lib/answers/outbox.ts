/**
 * The answer-event outbox (#17): every signed-in answer is queued first and
 * the queue drains first-in-first-out, so the server always sees events in the
 * order the player made them.
 *
 * Why the queue sits in front of even the live path: a mutation that fails is
 * indistinguishable from one whose *response* was lost. Sending "just try it
 * and queue on failure" would insert a duplicate for the second case. Always
 * enqueue-then-drain means every send carries its `eventId`, and the server's
 * exact lookup (`by_user_event`) turns the ambiguous case into a no-op. The
 * 5s network-retry window in `answers.answer` is skipped for these, because a
 * player who answered the same question twice while offline would otherwise
 * lose the second attempt on replay.
 *
 * Guests never enqueue: there is no account for the server to attribute the
 * events to, and a later sign-in deliberately does not backfill them. Queued
 * events carry the signed-in handle they were recorded under, and the drain
 * only sends another account's events for that account — signing out with
 * pending events parks them until that account signs back in, instead of
 * forging another player's history. Untagged events (no handle was known when
 * recorded) drain under whoever is signed in; the server attributes by auth
 * identity regardless.
 *
 * This module is the localStorage adapter. The rules — order, cap, sanitising,
 * transient retries, per-account attribution — are in `outboxCore.ts`,
 * shared verbatim with the native app (`apps/mobile/src/lib/outbox.ts`), so
 * the two stores cannot drift on the part the server actually depends on.
 */

import {
  appendQueued,
  EMPTY_OUTBOX,
  type OutboxState,
  type QueuedAnswer,
  type SendAnswer,
  resetReconcile,
  runDrain,
  sanitizeQueue,
  sendableEvents,
  shouldReconcile,
  withoutSent,
} from "./outboxCore";

const KEY = "endless-ai:answer-outbox:v1";

/**
 * Invalidates drains that are already in flight. `clearOutbox` bumps this;
 * every drain captures the value it started under and stops before its next
 * send once they differ.
 */
let generation = 0;

export { shouldReconcile };
export type { QueuedAnswer, SendAnswer };
export { OUTBOX_CAP } from "./outboxCore";

export function newEventId(): string {
  const cryptoApi = globalThis.crypto as Crypto | undefined;
  if (cryptoApi && typeof cryptoApi.randomUUID === "function") {
    return cryptoApi.randomUUID();
  }
  return `${Date.now().toString(36)}-${Math.floor(Math.random() * 2 ** 32).toString(36)}`;
}

function readOutbox(): QueuedAnswer[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = window.localStorage.getItem(KEY);
    if (!raw) return [];
    return sanitizeQueue(JSON.parse(raw));
  } catch {
    return [];
  }
}

function writeOutbox(pending: readonly QueuedAnswer[]): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(KEY, JSON.stringify(pending));
  } catch {
    /* private browsing, quota. The answers still painted locally. */
  }
}

const listeners = new Set<() => void>();

function set(pending: readonly QueuedAnswer[]) {
  current = { pending };
  writeOutbox([...pending]);
  for (const listener of listeners) listener();
}

let current: OutboxState = EMPTY_OUTBOX;

export function subscribeOutbox(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

let syncing = false;

/**
 * Cross-tab sync. Each tab keeps its own snapshot; without this, a second
 * tab's enqueues are invisible to the first until it writes something
 * itself, and its drains iterate a stale list. The writing tab's own drains
 * self-heal most of this, but a `storage` listener is one line per tab and
 * makes every tab's chip and drain current.
 */
export function startOutboxSync(): void {
  if (syncing || typeof window === "undefined") return;
  syncing = true;
  window.addEventListener("storage", (event) => {
    if (event.key !== KEY) return;
    const pending = readOutbox();
    const known = new Set(getOutboxSnapshot().pending.map((e) => e.eventId));
    if (
      pending.length !== getOutboxSnapshot().pending.length ||
      pending.some((e) => !known.has(e.eventId))
    ) {
      set(pending);
    }
  });
}

export function getOutboxSnapshot(): OutboxState {
  if (typeof window !== "undefined" && current === EMPTY_OUTBOX) {
    // Lazy-read localStorage on first render (#31), same as progress.ts: no
    // notify, because the render that triggered this read already holds the
    // fresh value and there is nothing to catch up on.
    const pending = readOutbox();
    if (pending.length > 0) {
      current = { pending };
    }
  }
  return current;
}

export function getOutboxServerSnapshot(): OutboxState {
  return EMPTY_OUTBOX;
}

export function enqueueAnswer(event: QueuedAnswer): void {
  set(appendQueued(getOutboxSnapshot().pending, event));
}

/**
 * Empties the queue, on disk as well as in memory. Called after a progress
 * reset is confirmed server-side: events queued between the enqueue and the
 * wipe would otherwise drain afterwards and resurrect the history that was
 * just deleted.
 *
 * Bumps the drain generation and forgets the reconcile watermarks, so a drain
 * that was already in flight stops before its next send and a stale result
 * resolving afterwards cannot overwrite the fresh 1000.
 */
export function clearOutbox(): void {
  generation += 1;
  resetReconcile();
  set([]);
}

function dropSettled(ids: Set<string>): void {
  const before = getOutboxSnapshot().pending;
  const pending = withoutSent(before, ids);
  if (pending.length !== before.length) set(pending);
}

/**
 * Sends the queue for the given account and reports how many left the device.
 * See `runDrain` for permanent drops and transient retries. This adapter
 * persists both successful sends and dropped rejections.
 */
export async function drainOutbox(
  send: SendAnswer,
  account: string | null,
): Promise<{ sent: number; lastRating: number | null; maxAt: number | null }> {
  const before = getOutboxSnapshot().pending;
  const gen = generation;
  const { sent, lastRating, maxAt, settledIds } = await runDrain(
    before,
    send,
    account,
    () => gen === generation,
  );
  if (settledIds.size > 0) dropSettled(settledIds);
  return { sent, lastRating, maxAt };
}

/** Re-exported for the tests and for callers that reason about the queue. */
export { sanitizeQueue, sendableEvents };
