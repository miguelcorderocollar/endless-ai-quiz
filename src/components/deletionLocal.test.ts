import { expect, it } from "vitest";
import { clearDeletedAccountStorage } from "./deletionLocal";

it("clears every app key, including unknown future keys, without clearing other storage", () => {
  const values = new Map([
    ["endless-ai:progress:v1", "private"],
    ["other-app", "keep"],
    ["endless-ai:outbox", "private"],
    ["endless-ai:profile", "private"],
    ["endless-ai:future-cache", "private"],
  ]);
  clearDeletedAccountStorage({
    get length() { return values.size; },
    key: i => [...values.keys()][i] ?? null,
    removeItem: key => { values.delete(key); },
  });
  expect([...values]).toEqual([["other-app", "keep"]]);
});

it("drops all outbox accounts and prevents an in-flight retryable rejection restoring events", async () => {
  const { vi } = await import("vitest");
  vi.resetModules();
  const values = new Map<string, string>();
  const storage = {
    get length() { return values.size; },
    key: (i: number) => [...values.keys()][i] ?? null,
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => { values.set(key, value); },
    removeItem: (key: string) => { values.delete(key); },
  };
  vi.stubGlobal("window", { localStorage: storage });
  try {
    const outbox = await import("@/lib/answers/outbox");
    const { clearDeletedAccountStorage: clear } = await import("./deletionLocal");
    const { SIGN_IN_REQUIRED } = await import("@/lib/answers/errors");
    for (const [index, account] of ["deleted", "other", null].entries()) {
      outbox.enqueueAnswer({ eventId: `event-${index}`, account, questionId: "con-test", picked: "yes", at: index });
    }
    let rejectSend!: (error: Error) => void;
    const send = vi.fn(() => new Promise<never>((_resolve, reject) => { rejectSend = reject; }));
    const drain = outbox.drainOutbox(send, "deleted");
    clear(storage);
    rejectSend(new Error(SIGN_IN_REQUIRED));
    await drain;
    expect(send).toHaveBeenCalledTimes(1);
    expect(outbox.getOutboxSnapshot().pending).toEqual([]);
    expect(outbox.getOutboxSnapshot().retryAt).toBeUndefined();
    expect(values.has("endless-ai:answer-outbox:v1")).toBe(false);
  } finally {
    vi.unstubAllGlobals();
  }
});
