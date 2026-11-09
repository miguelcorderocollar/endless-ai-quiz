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

it.each(["signOut", "reset"] as const)("ignores a drain response that arrives after %s", async reason => {
  const s = await setup();
  s.enqueueAnswer(queue("alice", "a"));
  s.enqueueAnswer(queue("alice", "later"));
  let finish!: (result: { ratingAfter: number }) => void;
  const send = vi.fn(() => new Promise<{ ratingAfter: number }>(resolve => { finish = resolve; }));
  const drain = s.drainOutbox(send, "alice");
  s.clearLocalAccountState(reason === "reset" ? { reason, account: "alice" } : { reason });
  finish({ ratingAfter: 1900 });
  expect(await drain).toEqual({ sent: 0, lastRating: null, maxAt: null });
  expect(send).toHaveBeenCalledTimes(1);
  expect(s.readProgress()).toEqual(s.EMPTY_PROGRESS);
});
