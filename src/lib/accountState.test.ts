import { beforeEach, expect, it, vi } from "vitest";

const storage = new Map<string, string>();
beforeEach(() => {
  vi.resetModules();
  storage.clear();
  vi.stubGlobal("window", { localStorage: {
    getItem: (key: string) => storage.get(key) ?? null,
    setItem: (key: string, value: string) => storage.set(key, value),
    removeItem: (key: string) => storage.delete(key),
    key: (index: number) => [...storage.keys()][index] ?? null,
    get length() { return storage.size; },
  } });
});

async function setup() {
  const state = await import("./accountState");
  const progress = await import("./progress");
  const outbox = await import("./answers/outbox");
  const session = await import("./quiz/session");
  return { ...state, ...progress, ...outbox, ...session };
}

function queue(account: string | null, eventId: string) {
  return { eventId, account, questionId: "con-9001", picked: "answer", at: 1 };
}

it("restores guest progress after account totals, including after a reload", async () => {
  let s = await setup();
  const guest = { ...s.EMPTY_PROGRESS, answered: 7, completed: ["guest"], recent: [{ id: "guest", correct: true, at: 1 }] };
  s.updateProgress(guest);
  s.snapshotGuestProgress();
  s.updateProgress({ ...s.EMPTY_PROGRESS, rating: 1800, answered: 90, completed: ["private"] });
  vi.resetModules();
  s = await setup();
  s.clearLocalAccountState({ reason: "signOut" });
  expect(s.getProgressSnapshot()).toEqual(guest);
  expect(s.readProgress()).toEqual(guest);
  expect(storage.has("endless-ai:guest-progress:v1")).toBe(false);
  // The snapshot is consumed, so a later account without a guest starts empty.
  s.updateProgress({ ...s.EMPTY_PROGRESS, answered: 50 });
  s.clearLocalAccountState({ reason: "signOut" });
  expect(s.getProgressSnapshot()).toEqual(s.EMPTY_PROGRESS);
});

it("clears all draw variants, list, counts, profile and session, preserving preferences and parked events", async () => {
  const s = await setup();
  const keys = ["draw-cache:v1:all", "draw-cache:v1:concepts", "bank-list:v1", "counts:v1", "profile:v1"];
  for (const key of keys) storage.set(`endless-ai:${key}`, "{}");
  storage.set("endless-ai:filter:v1", '["concepts"]');
  s.quizSession.current = { filterKey: "", currentId: "private", seenIds: ["private"], phase: "revealed", picked: "answer", exhausted: true };
  s.enqueueAnswer(queue("alice", "a"));
  s.enqueueAnswer(queue("bob", "b"));
  s.clearLocalAccountState({ reason: "signOut" });
  for (const key of keys) expect(storage.has(`endless-ai:${key}`)).toBe(false);
  expect(s.quizSession.current).toBe(null);
  expect(s.getOutboxSnapshot().pending.map(e => e.eventId)).toEqual(["a", "b"]);
  expect(storage.get("endless-ai:filter:v1")).toBe('["concepts"]');
  expect(s.readProgress()).toEqual(s.EMPTY_PROGRESS);
});

it("reset drops only the current account and untagged events and keeps the guest snapshot", async () => {
  const s = await setup();
  const guest = { ...s.EMPTY_PROGRESS, answered: 4 };
  s.updateProgress(guest);
  s.snapshotGuestProgress();
  s.updateProgress({ ...s.EMPTY_PROGRESS, answered: 99 });
  s.enqueueAnswer(queue("alice", "a"));
  s.enqueueAnswer(queue("bob", "b"));
  s.enqueueAnswer(queue(null, "legacy"));
  s.clearLocalAccountState({ reason: "reset", account: "alice" });
  expect(s.getOutboxSnapshot().pending.map(e => e.eventId)).toEqual(["b"]);
  expect(s.readProgress()).toEqual(s.EMPTY_PROGRESS);
  s.clearLocalAccountState({ reason: "signOut" });
  expect(s.readProgress()).toEqual(guest);
});

it("waits for sign-out and leaves progress intact if auth teardown rejects", async () => {
  const s = await setup();
  s.updateProgress({ ...s.EMPTY_PROGRESS, answered: 20 });
  let finish!: () => void;
  const result = s.signOutAndClear(() => new Promise<void>(resolve => { finish = resolve; }));
  expect(s.readProgress().answered).toBe(20);
  finish();
  await result;
  expect(s.readProgress()).toEqual(s.EMPTY_PROGRESS);
  s.updateProgress({ ...s.EMPTY_PROGRESS, answered: 30 });
  await expect(s.signOutAndClear(() => Promise.reject(new Error("auth")))).rejects.toThrow("auth");
  expect(s.readProgress().answered).toBe(30);
});

it.each(["signOut", "reset", "deletion"] as const)("ignores a drain response that arrives after %s", async reason => {
  const s = await setup();
  s.enqueueAnswer(queue("alice", "a"));
  s.enqueueAnswer(queue("alice", "later"));
  let finish!: (result: { ratingAfter: number }) => void;
  const send = vi.fn(() => new Promise<{ ratingAfter: number }>(resolve => { finish = resolve; }));
  const drain = s.drainOutbox(send, "alice");
  s.clearLocalAccountState(reason !== "signOut" ? { reason, account: "alice" } : { reason });
  finish({ ratingAfter: 1900 });
  expect(await drain).toEqual({ sent: 1, lastRating: null, maxAt: null });
  expect(send).toHaveBeenCalledTimes(1);
  expect(s.getOutboxSnapshot().pending.map(e => e.eventId)).toEqual(reason === "signOut" ? ["later"] : []);
  expect(s.readProgress()).toEqual(s.EMPTY_PROGRESS);
});

it("drops untagged answers at sign-out so the next account cannot replay them", async () => {
  const s = await setup();
  s.enqueueAnswer(queue(null, "unowned-a"));
  s.enqueueAnswer(queue("alice", "a"));
  s.enqueueAnswer(queue("bob", "b"));
  s.clearLocalAccountState({ reason: "signOut" });
  expect(s.sendableEvents(s.getOutboxSnapshot().pending, "bob").map(e => e.eventId)).toEqual(["b"]);
});

it("flushes before invalidating so a successful send is removed before sign-out", async () => {
  const s = await setup();
  s.enqueueAnswer(queue("alice", "a"));
  const order: string[] = [];
  const parked = await s.signOutAndClear(async () => { order.push("signOut"); }, {
    drain: () => s.drainOutbox(async () => {
      order.push("send");
      return { ratingAfter: 1200 };
    }, "alice"),
  });
  expect(order).toEqual(["send", "signOut"]);
  expect(parked).toBe(0);
  expect(s.getOutboxSnapshot().pending).toEqual([]);
});

it("bounds hung flush and auth requests, clears local credentials, and reports parked answers", async () => {
  const s = await setup();
  vi.useFakeTimers();
  try {
    s.enqueueAnswer(queue("alice", "a"));
    const clearTokens = vi.fn();
    const result = s.signOutAndClear(() => new Promise(() => {}), {
      drain: () => new Promise(() => {}), clearTokens, timeoutMs: 10,
    });
    await vi.advanceTimersByTimeAsync(20);
    expect(await result).toBe(1);
    expect(clearTokens).toHaveBeenCalledOnce();
    expect(s.readProgress()).toEqual(s.EMPTY_PROGRESS);
    expect(s.getOutboxSnapshot().pending.map(e => e.eventId)).toEqual(["a"]);
  } finally { vi.useRealTimers(); }
});

it("deletion discards the guest snapshot and only the deleted account's queue", async () => {
  const s = await setup();
  s.updateProgress({ ...s.EMPTY_PROGRESS, answered: 12 });
  s.snapshotGuestProgress();
  s.enqueueAnswer(queue("alice", "a"));
  s.enqueueAnswer(queue("bob", "b"));
  s.clearLocalAccountState({ reason: "deletion", account: "alice" });
  expect(s.readProgress()).toEqual(s.EMPTY_PROGRESS);
  expect(storage.has("endless-ai:guest-progress:v1")).toBe(false);
  expect(s.getOutboxSnapshot().pending.map(e => e.eventId)).toEqual(["b"]);
  s.clearLocalAccountState({ reason: "signOut" });
  expect(s.readProgress()).toEqual(s.EMPTY_PROGRESS);
});

it("clears this tab's in-memory state on a namespaced token removal", async () => {
  const s = await setup();
  s.updateProgress({ ...s.EMPTY_PROGRESS, answered: 99 });
  s.enqueueAnswer(queue(null, "unowned"));
  const reload = vi.fn();
  s.handleAuthTokenRemoval({ key: "__convexAuthJWT_httpsotherconvexcloud", newValue: null }, "https://test.convex.cloud", reload);
  expect(reload).not.toHaveBeenCalled();
  s.handleAuthTokenRemoval({ key: "__convexAuthJWT_httpstestconvexcloud", newValue: null }, "https://test.convex.cloud", reload);
  expect(reload).toHaveBeenCalledOnce();
  expect(s.getProgressSnapshot()).toEqual(s.EMPTY_PROGRESS);
  expect(s.getOutboxSnapshot().pending).toEqual([]);
});

it("removes only the configured deployment's auth credentials", async () => {
  const s = await setup();
  storage.set("__convexAuthJWT_httpstestconvexcloud", "token");
  storage.set("__convexAuthRefreshToken_httpstestconvexcloud", "refresh");
  storage.set("__convexAuthJWT_httpsotherconvexcloud", "other");
  s.clearLocalAuthTokens("https://test.convex.cloud");
  expect([...storage.values()]).toEqual(["other"]);
});

it("invalidates replay before reset starts, while preserving state when reset fails", async () => {
  const s = await setup();
  s.updateProgress({ ...s.EMPTY_PROGRESS, answered: 20 });
  s.enqueueAnswer(queue("alice", "a"));
  s.enqueueAnswer(queue("alice", "later"));
  let finish!: (value: { ratingAfter: number }) => void;
  const send = vi.fn(() => new Promise<{ ratingAfter: number }>(resolve => { finish = resolve; }));
  const drain = s.drainOutbox(send, "alice");
  const reset = s.resetProgressAndClear(async () => {
    finish({ ratingAfter: 1900 });
    expect(await drain).toEqual({ sent: 1, lastRating: null, maxAt: null });
    throw new Error("reset failed");
  }, "alice");
  await expect(reset).rejects.toThrow("reset failed");
  expect(send).toHaveBeenCalledTimes(1);
  expect(s.readProgress().answered).toBe(20);
  expect(s.getOutboxSnapshot().pending.map(e => e.eventId)).toEqual(["later"]);
});
