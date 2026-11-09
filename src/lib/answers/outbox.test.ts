import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The answer outbox (#17, #57). Events retain record order across transient
 * failures; permanent rejections leave the queue so later events can sync.
 * Server-side eventId dedupe is covered in `convex/answers.test.ts`.
 *
 * Module state is fresh per test via `vi.resetModules`, the same trick as
 * `install.test.ts`. `localStorage` is a shared Map so a "reload" is just a
 * re-import.
 */

const storage = new Map<string, string>();

function stubWindow() {
  Object.defineProperty(globalThis, "window", {
    value: {
      localStorage: {
        getItem: (key: string) => storage.get(key) ?? null,
        setItem: (key: string, value: string) => void storage.set(key, value),
        removeItem: (key: string) => void storage.delete(key),
      },
    },
    configurable: true,
  });
}

async function load() {
  vi.resetModules();
  stubWindow();
  return import("@/lib/answers/outbox");
}

beforeEach(() => {
  storage.clear();
  vi.unstubAllGlobals();
});

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

describe("enqueue / snapshots", () => {
  it("persists events and returns a stable snapshot between changes", async () => {
    const { enqueueAnswer, getOutboxSnapshot } = await load();

    enqueueAnswer(event({ eventId: "e1" }));
    const afterFirst = getOutboxSnapshot();
    expect(afterFirst.pending.map((e) => e.eventId)).toEqual(["e1"]);
    expect(getOutboxSnapshot()).toBe(afterFirst);

    enqueueAnswer(event({ eventId: "e2" }));
    expect(getOutboxSnapshot()).not.toBe(afterFirst);
    expect(getOutboxSnapshot().pending.map((e) => e.eventId)).toEqual(["e1", "e2"]);
  });

  it("survives a reload through localStorage", async () => {
    const first = await load();
    first.enqueueAnswer(event({ eventId: "e1" }));

    const second = await load();
    expect(second.getOutboxSnapshot().pending.map((e) => e.eventId)).toEqual(["e1"]);
  });

  it("drops malformed entries and restores chronological order", async () => {
    storage.set(
      "endless-ai:answer-outbox:v1",
      JSON.stringify([
        event({ eventId: "late", at: 200 }),
        "garbage",
        { questionId: "x" },
        event({ eventId: "early", at: 100 }),
        event({ eventId: "no-clock", at: undefined }),
      ]),
    );

    const { getOutboxSnapshot } = await load();
    expect(getOutboxSnapshot().pending.map((e) => e.eventId)).toEqual([
      "no-clock",
      "early",
      "late",
    ]);
  });

  it("caps the queue instead of growing localStorage without bound", async () => {
    const { enqueueAnswer, getOutboxSnapshot } = await load();
    for (let i = 0; i < 1005; i++) {
      enqueueAnswer(event({ eventId: `e${i}`, at: i }));
    }
    const pending = getOutboxSnapshot().pending;
    expect(pending).toHaveLength(1000);
    expect(pending[0]!.eventId).toBe("e5");
    expect(pending[999]!.eventId).toBe("e1004");
  });
});

describe("drainOutbox", () => {
  it("sends head-first for the account and reports the last rating", async () => {
    const { drainOutbox, enqueueAnswer } = await load();
    enqueueAnswer(event({ eventId: "e1", at: 1 }));
    enqueueAnswer(event({ eventId: "e2", at: 2 }));
    enqueueAnswer(event({ eventId: "e3", at: 3 }));

    const sent: string[] = [];
    const result = await drainOutbox(async (args) => {
      sent.push(args.eventId);
      return { ratingAfter: 1000 + sent.length * 10 };
    }, "atlas");

    expect(sent).toEqual(["e1", "e2", "e3"]);
    expect(result).toEqual({ sent: 3, lastRating: 1030, maxAt: 3 });

    const { getOutboxSnapshot } = await load();
    expect(getOutboxSnapshot().pending).toEqual([]);
  });

  it("leaves other accounts parked and keeps sending ours behind them", async () => {
    const { drainOutbox, enqueueAnswer } = await load();
    enqueueAnswer(event({ eventId: "theirs", account: "bruno", at: 1 }));
    enqueueAnswer(event({ eventId: "ours", account: "atlas", at: 2 }));

    const sent: string[] = [];
    const result = await drainOutbox(async (args) => {
      sent.push(args.eventId);
      return { ratingAfter: 1000 };
    }, "atlas");

    expect(sent).toEqual(["ours"]);
    expect(result).toEqual({ sent: 1, lastRating: 1000, maxAt: 2 });

    const { getOutboxSnapshot } = await load();
    expect(getOutboxSnapshot().pending.map((e) => e.eventId)).toEqual(["theirs"]);
  });

  it("sends untagged events under whoever is draining", async () => {
    const { drainOutbox, enqueueAnswer } = await load();
    enqueueAnswer(event({ eventId: "untagged", account: null, at: 1 }));
    enqueueAnswer(event({ eventId: "theirs", account: "bruno", at: 2 }));

    const sent: string[] = [];
    const result = await drainOutbox(async (args) => {
      sent.push(args.eventId);
      return { ratingAfter: 1000 };
    }, "atlas");

    // The untagged event drains; the other account's stays parked. Stranding
    // the untagged ones was a silent permanent loss (review on #43).
    expect(sent).toEqual(["untagged"]);
    expect(result.sent).toBe(1);

    const { getOutboxSnapshot } = await load();
    expect(getOutboxSnapshot().pending.map((e) => e.eventId)).toEqual(["theirs"]);
  });

  it("stops at the first transient failure and keeps everything from there on", async () => {
    const { drainOutbox, enqueueAnswer } = await load();
    enqueueAnswer(event({ eventId: "e1", at: 1 }));
    enqueueAnswer(event({ eventId: "e2", at: 2 }));
    enqueueAnswer(event({ eventId: "e3", at: 3 }));

    const sent: string[] = [];
    const result = await drainOutbox(async (args) => {
      if (args.eventId === "e2") throw new Error("offline");
      sent.push(args.eventId);
      return { ratingAfter: 1000 };
    }, "atlas");

    expect(sent).toEqual(["e1"]);
    expect(result).toEqual({ sent: 1, lastRating: 1000, maxAt: 1 });

    const { getOutboxSnapshot } = await load();
    expect(getOutboxSnapshot().pending.map((e) => e.eventId)).toEqual(["e2", "e3"]);
  });

  it("drops a permanent failure in the middle and persists later successes", async () => {
    const { drainOutbox, enqueueAnswer, getOutboxSnapshot } = await load();
    const { ConvexError } = await import("convex/values");
    enqueueAnswer(event({ eventId: "e1", at: 1 }));
    enqueueAnswer(event({ eventId: "bad", at: 2 }));
    enqueueAnswer(event({ eventId: "e3", at: 3 }));
    enqueueAnswer(event({ eventId: "theirs", account: "bruno", at: 4 }));

    const attempts: string[] = [];
    const result = await drainOutbox(async ({ eventId }) => {
      attempts.push(eventId);
      if (eventId === "bad") throw new ConvexError("Unknown question.");
      return { ratingAfter: eventId === "e3" ? 1020 : 1010 };
    }, "atlas");

    expect(attempts).toEqual(["e1", "bad", "e3"]);
    expect(result).toEqual({ sent: 2, lastRating: 1020, maxAt: 3 });
    expect(getOutboxSnapshot().pending.map((e) => e.eventId)).toEqual(["theirs"]);
    const reloaded = await load();
    expect(reloaded.getOutboxSnapshot().pending.map((e) => e.eventId)).toEqual([
      "theirs",
    ]);
  });

  it("drops a rejected head but parks a subsequent transient failure", async () => {
    const { drainOutbox, enqueueAnswer, getOutboxSnapshot } = await load();
    const { ConvexError } = await import("convex/values");
    for (const [i, eventId] of ["bad", "offline", "later"].entries()) {
      enqueueAnswer(event({ eventId, at: i }));
    }
    const attempts: string[] = [];
    const result = await drainOutbox(async ({ eventId }) => {
      attempts.push(eventId);
      if (eventId === "bad") throw new ConvexError({ code: "INVALID_ANSWER" });
      throw new Error("offline");
    }, "atlas");

    expect(attempts).toEqual(["bad", "offline"]);
    expect(result).toEqual({ sent: 0, lastRating: null, maxAt: null });
    expect(getOutboxSnapshot().pending.map((e) => e.eventId)).toEqual([
      "offline", "later",
    ]);
    const retried = await drainOutbox(async () => ({ ratingAfter: 1010 }), "atlas");
    expect(retried).toEqual({ sent: 2, lastRating: 1010, maxAt: 2 });
  });

  it("does not reconcile ratings from a dropped final event", async () => {
    const { drainOutbox, enqueueAnswer, getOutboxSnapshot } = await load();
    const { ConvexError } = await import("convex/values");
    enqueueAnswer(event({ eventId: "ok", at: 1 }));
    enqueueAnswer(event({ eventId: "bad", at: 2 }));
    const result = await drainOutbox(async ({ eventId }) => {
      if (eventId === "bad") throw new ConvexError("Unknown question.");
      return { ratingAfter: 1010 };
    }, "atlas");
    expect(result).toEqual({ sent: 1, lastRating: 1010, maxAt: 1 });
    expect(getOutboxSnapshot().pending).toEqual([]);
  });

  it.each(["auth", "timeout", "rate limit", "untyped rejection"])(
    "retains %s failures for retry",
    async (kind) => {
      const { drainOutbox, enqueueAnswer, getOutboxSnapshot } = await load();
      const { ConvexError } = await import("convex/values");
      const errors = {
        auth: new ConvexError("Sign in required."),
        timeout: new Error("Request timed out"),
        "rate limit": new ConvexError({ kind: "RateLimited", name: "answer", retryAfter: 1000 }),
        "untyped rejection": "Unknown question.",
      };
      enqueueAnswer(event({ eventId: "e1", at: 1 }));
      enqueueAnswer(event({ eventId: "e2", at: 2 }));
      const send = vi.fn(async () => {
        throw errors[kind as keyof typeof errors];
      });
      expect(await drainOutbox(send, "atlas")).toEqual({
        sent: 0, lastRating: null, maxAt: null,
      });
      expect(send).toHaveBeenCalledTimes(1);
      expect(getOutboxSnapshot().pending.map((e) => e.eventId)).toEqual(["e1", "e2"]);
    },
  );

  it("treats a deduped server reply as delivered, not as a retry", async () => {
    const { drainOutbox, enqueueAnswer } = await load();
    enqueueAnswer(event({ eventId: "e1", at: 1 }));

    const result = await drainOutbox(async () => ({ ratingAfter: 999 }), "atlas");

    expect(result).toEqual({ sent: 1, lastRating: 999, maxAt: expect.any(Number) });
    const { getOutboxSnapshot } = await load();
    expect(getOutboxSnapshot().pending).toEqual([]);
  });
});

describe("shouldReconcile", () => {
  it("lets the newest-sent event win across overlapping drains", async () => {
    const { drainOutbox, enqueueAnswer, shouldReconcile } = await load();
    enqueueAnswer(event({ eventId: "e1", at: 100 }));

    // The first drain starts while only e1 exists; its send hangs. A second
    // answer lands, a second drain sends both and resolves first, then the
    // older drain's e1 resolves. Without the guard the local rating would
    // regress to the older result and stay there, since nothing re-triggers.
    let releaseFirst: (() => void) | null = null;
    const gate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const first = drainOutbox(async () => {
      await gate;
      return { ratingAfter: 1010 };
    }, "atlas");

    enqueueAnswer(event({ eventId: "e2", at: 200 }));
    const second = await drainOutbox(async () => ({ ratingAfter: 1020 }), "atlas");
    releaseFirst!();
    const firstResult = await first;

    expect(second).toMatchObject({ sent: 2, lastRating: 1020, maxAt: 200 });
    expect(firstResult).toMatchObject({ sent: 1, lastRating: 1010, maxAt: 100 });

    const applied: number[] = [];
    if (shouldReconcile("atlas", second.maxAt)) applied.push(second.lastRating!);
    if (shouldReconcile("atlas", firstResult.maxAt))
      applied.push(firstResult.lastRating!);
    expect(applied).toEqual([1020]);
  });

  it("reconciles ties last-writer-wins", async () => {
    const { shouldReconcile } = await load();
    expect(shouldReconcile("atlas", 100)).toBe(true);
    expect(shouldReconcile("atlas", 100)).toBe(true);
    expect(shouldReconcile("atlas", 99)).toBe(false);
  });

  it("tracks accounts separately, so a new sign-in reconciles", async () => {
    const { shouldReconcile } = await load();
    // Atlas drains late events; Bruno signs in after, with an older watermark.
    // A single global guard would suppress Bruno's reconcile and leave the
    // device showing Atlas's rating under Bruno's name.
    expect(shouldReconcile("atlas", 200)).toBe(true);
    expect(shouldReconcile("bruno", 100)).toBe(true);
    expect(shouldReconcile("bruno", 99)).toBe(false);
  });

  it("stops a drain overtaken by a reset instead of replaying behind it", async () => {
    const { clearOutbox, drainOutbox, enqueueAnswer, getOutboxSnapshot } =
      await load();
    enqueueAnswer(event({ eventId: "e1", at: 1 }));
    enqueueAnswer(event({ eventId: "e2", at: 2 }));

    const sent: string[] = [];
    const result = await drainOutbox(async (args) => {
      sent.push(args.eventId);
      // The reset lands while the drain is between sends. e1 was already on
      // the wire and cannot be unsent; e2 must never leave the device.
      if (args.eventId === "e1") clearOutbox();
      return { ratingAfter: 1000 };
    }, "atlas");

    expect(sent).toEqual(["e1"]);
    expect(result.sent).toBe(1);
    expect(getOutboxSnapshot().pending).toEqual([]);
  });

  it("forgets reconcile watermarks on reset", async () => {
    const { clearOutbox, shouldReconcile } = await load();
    expect(shouldReconcile("atlas", 200)).toBe(true);
    clearOutbox();
    // Without the reset a stale in-flight drain resolving now would pass the
    // tie-or-newer check and overwrite the fresh 1000 with its pre-reset
    // rating.
    expect(shouldReconcile("atlas", 100)).toBe(true);
  });
});


afterEach(() => vi.useRealTimers());

it("retries a quota-retained queue on its deadline without another answer, and cancels on cleanup", async () => {
  vi.useFakeTimers();
  const { drainOutbox, enqueueAnswer, getOutboxSnapshot, subscribeOutbox, clearOutbox } = await load();
  const { watchOutboxRetries } = await import("@/lib/answers/outboxCore");
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
