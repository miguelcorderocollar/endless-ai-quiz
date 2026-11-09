import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The native outbox (#18 closing #17's half on Android). The rules under test
 * are not native rules — they live in the shared core and the web suite covers
 * them. What is native, and what this file exists for, is the AsyncStorage
 * half: the async hydrate, the write-through mirror, and the removal
 * re-reading that mirror after the drain's awaits.
 *
 * AsyncStorage is a native module, so it is stubbed with the same Map the web
 * suite uses for localStorage. A "relaunch" is then a fresh module import
 * against the same Map.
 */
const store = new Map<string, string>();

vi.mock("@react-native-async-storage/async-storage", () => ({
  default: {
    getItem: vi.fn(async (key: string) => store.get(key) ?? null),
    setItem: vi.fn(async (key: string, value: string) => {
      store.set(key, value);
    }),
    removeItem: vi.fn(async (key: string) => {
      store.delete(key);
    }),
  },
}));

async function load() {
  vi.resetModules();
  const module = await import("./outbox");
  await module.hydrateOutbox();
  return module;
}

function event(partial: Record<string, unknown> = {}) {
  return {
    eventId: `evt-${Math.random().toString(36).slice(2)}`,
    questionId: "con-9001",
    picked: "Machine learning",
    account: "atlas",
    at: Date.now(),
    ...partial,
  };
}

beforeEach(() => {
  store.clear();
});

describe("hydrateOutbox", () => {
  it("reads a queue written by a previous launch", async () => {
    store.set(
      "endless-ai:answer-outbox:v1",
      JSON.stringify([event({ eventId: "e1", at: 1 })]),
    );
    const { getOutboxSnapshot } = await load();
    expect(getOutboxSnapshot().pending.map((e) => e.eventId)).toEqual(["e1"]);
  });

  it("survives an unparseable queue instead of wedging the quiz", async () => {
    store.set("endless-ai:answer-outbox:v1", "{not json");
    const { getOutboxSnapshot, enqueueAnswer } = await load();
    expect(getOutboxSnapshot().pending).toEqual([]);
    enqueueAnswer(event({ eventId: "e1" }));
    expect(getOutboxSnapshot().pending).toHaveLength(1);
  });

  it("notifies subscribers so a mounted masthead leaves its loading state", async () => {
    store.set(
      "endless-ai:answer-outbox:v1",
      JSON.stringify([event({ eventId: "e1" })]),
    );
    vi.resetModules();
    const { getOutboxSnapshot, hydrateOutbox, subscribeOutbox } =
      await import("./outbox");
    expect(getOutboxSnapshot().pending).toEqual([]);
    let calls = 0;
    const off = subscribeOutbox(() => {
      calls += 1;
    });
    await hydrateOutbox();
    off();
    expect(calls).toBe(1);
    expect(getOutboxSnapshot().pending).toHaveLength(1);
  });
});

describe("drainOutbox on AsyncStorage", () => {
  it("sends in record order, stops at the first transient failure and parks the rest", async () => {
    const { drainOutbox, enqueueAnswer, getOutboxSnapshot } = await load();
    enqueueAnswer(event({ eventId: "e1", at: 1 }));
    enqueueAnswer(event({ eventId: "e2", at: 2 }));
    enqueueAnswer(event({ eventId: "e3", at: 3 }));

    const sent: string[] = [];
    const result = await drainOutbox(async (args) => {
      if (args.eventId === "e2") throw new Error("offline");
      sent.push(args.eventId);
      return { ratingAfter: 1000 + sent.length * 10 };
    }, "atlas");

    expect(sent).toEqual(["e1"]);
    expect(result).toEqual({ sent: 1, lastRating: 1010, maxAt: 1 });
    // e2 and e3 survive the drain, and they are still on disk for the next try.
    expect(getOutboxSnapshot().pending.map((e) => e.eventId)).toEqual([
      "e2",
      "e3",
    ]);
    const second = await load();
    expect(second.getOutboxSnapshot().pending.map((e) => e.eventId)).toEqual([
      "e2",
      "e3",
    ]);
  });

  it("persists removal of a permanent rejection and sends the next event", async () => {
    const { drainOutbox, enqueueAnswer, getOutboxSnapshot } = await load();
    const { ConvexError } = await import("convex/values");
    enqueueAnswer(event({ eventId: "bad", at: 1 }));
    enqueueAnswer(event({ eventId: "ok", at: 2 }));
    const attempts: string[] = [];
    const result = await drainOutbox(async ({ eventId }) => {
      attempts.push(eventId);
      if (eventId === "bad") throw new ConvexError("Unknown question.");
      // A new event must survive removal based on the drain snapshot.
      enqueueAnswer(event({ eventId: "new", at: 3 }));
      return { ratingAfter: 1010 };
    }, "atlas");
    expect(attempts).toEqual(["bad", "ok"]);
    expect(result).toEqual({ sent: 1, lastRating: 1010, maxAt: 2 });
    expect(getOutboxSnapshot().pending.map((e) => e.eventId)).toEqual(["new"]);
    const reloaded = await load();
    expect(reloaded.getOutboxSnapshot().pending.map((e) => e.eventId)).toEqual([
      "new",
    ]);
  });

  it("leaves another account's events parked rather than forging its history", async () => {
    const { drainOutbox, enqueueAnswer, getOutboxSnapshot } = await load();
    enqueueAnswer(event({ eventId: "theirs", account: "bruno", at: 1 }));
    enqueueAnswer(event({ eventId: "ours", account: "atlas", at: 2 }));

    const sent: string[] = [];
    await drainOutbox(async (args) => {
      sent.push(args.eventId);
      return { ratingAfter: 1000 };
    }, "atlas");

    expect(sent).toEqual(["ours"]);
    expect(getOutboxSnapshot().pending.map((e) => e.eventId)).toEqual([
      "theirs",
    ]);
  });

  it("keeps an answer enqueued while the drain is in flight", async () => {
    const { drainOutbox, enqueueAnswer, getOutboxSnapshot } = await load();
    enqueueAnswer(event({ eventId: "e1", at: 1 }));

    let release: (() => void) | null = null;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const draining = drainOutbox(async () => {
      await gate;
      return { ratingAfter: 1010 };
    }, "atlas");

    // The player answers again while the first send is still open.
    enqueueAnswer(event({ eventId: "e2", at: 2 }));
    release!();
    await draining;

    // Dropping from the list that was drained would have deleted e2 as well.
    expect(getOutboxSnapshot().pending.map((e) => e.eventId)).toEqual(["e2"]);
  });

  it("caps the queue and keeps the newest events", async () => {
    const { enqueueAnswer, getOutboxSnapshot } = await load();
    for (let i = 0; i < 1005; i += 1) {
      enqueueAnswer(event({ eventId: `e${i}`, at: i }));
    }
    const pending = getOutboxSnapshot().pending;
    expect(pending).toHaveLength(1000);
    expect(pending[0]?.eventId).toBe("e5");
    expect(pending.at(-1)?.eventId).toBe("e1004");
  });

  it("stops a drain overtaken by a reset instead of replaying behind it", async () => {
    const { clearOutbox, drainOutbox, enqueueAnswer, getOutboxSnapshot } =
      await load();
    enqueueAnswer(event({ eventId: "e1", at: 1 }));
    enqueueAnswer(event({ eventId: "e2", at: 2 }));

    const sent: string[] = [];
    const result = await drainOutbox(async (args) => {
      sent.push(args.eventId);
      if (args.eventId === "e1") clearOutbox();
      return { ratingAfter: 1000 };
    }, "atlas");

    expect(sent).toEqual(["e1"]);
    expect(result.sent).toBe(1);
    expect(getOutboxSnapshot().pending).toEqual([]);
  });
});


afterEach(() => vi.useRealTimers());

it("retries a quota-retained queue on its deadline without another answer, and cancels on cleanup", async () => {
  vi.useFakeTimers();
  const { drainOutbox, enqueueAnswer, getOutboxSnapshot, subscribeOutbox, clearOutbox } = await load();
  const { watchOutboxRetries } = await import("@shared/lib/answers/outboxCore");
  const { ConvexError } = await import("convex/values");
  enqueueAnswer(event({ eventId: "q1" }));
  enqueueAnswer(event({ eventId: "q2" }));
  const send = vi.fn()
    .mockRejectedValueOnce(new ConvexError({ kind: "RateLimited", retryAfter: 500 }))
    .mockResolvedValue({ ratingAfter: 1010 });
  const flush = () => drainOutbox(send, "atlas");
  const stop = watchOutboxRetries(subscribeOutbox, getOutboxSnapshot, flush);
  await flush();
  expect(getOutboxSnapshot().pending).toHaveLength(2);
  expect(getOutboxSnapshot().retryAt).toBe(Date.now() + 500);
  await vi.advanceTimersByTimeAsync(499);
  expect(send).toHaveBeenCalledTimes(1);
  await vi.advanceTimersByTimeAsync(1);
  expect(send).toHaveBeenCalledTimes(3);
  expect(getOutboxSnapshot().pending).toHaveLength(0);
  expect(getOutboxSnapshot().retryAt).toBeUndefined();
  enqueueAnswer(event({ eventId: "cancelled" }));
  send.mockRejectedValue(new ConvexError({ kind: "RateLimited", retryAfter: 500 }));
  await flush();
  clearOutbox();
  expect(vi.getTimerCount()).toBe(0);
  enqueueAnswer(event({ eventId: "signed-out" }));
  await flush();
  const calls = send.mock.calls.length;
  stop();
  await vi.advanceTimersByTimeAsync(1000);
  expect(send).toHaveBeenCalledTimes(calls);
});
