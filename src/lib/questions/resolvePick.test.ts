import { describe, expect, it, vi } from "vitest";
import type { Question } from "./schema";
import { REVEAL_TIMEOUT_MS, resolvePick } from "./resolvePick";

const local: Question = {
  id: "con-9001", text: "Question?", options: ["a", "b", "c", "d"],
  answer: "a", explanation: "Because a", source: { kind: "none" },
  category: "concepts", difficulty: 1, tags: [], answerAliases: [],
  status: "published", addedAt: "2026-01-01",
};
const redacted: Question = { ...local, answer: "", explanation: "" };

describe("resolvePick", () => {
  it("waits for server reveal and never loads the fallback online", async () => {
    const fallback = vi.fn();
    const reveal = vi.fn(async () => ({ ...local, correct: true }));
    const result = await resolvePick(redacted, "a", true, reveal, fallback);
    expect(reveal).toHaveBeenCalledWith({ questionId: local.id, picked: "a" });
    expect(fallback).not.toHaveBeenCalled();
    expect(result.answer).toBe("a");
    expect(redacted.answer).toBe("");
  });
  it("resolves a redacted cached question from the offline bank after a pick", async () => {
    const reveal = vi.fn();
    expect(await resolvePick(redacted, "b", false, reveal, async () => [local])).toEqual(local);
    expect(reveal).not.toHaveBeenCalled();
  });
  it("keeps cached full questions playable without a connection", async () => {
    const reveal = vi.fn();
    const fallback = vi.fn();
    expect(await resolvePick(local, "a", false, reveal, fallback)).toEqual(local);
    expect(reveal).not.toHaveBeenCalled();
    expect(fallback).not.toHaveBeenCalled();
  });
  it("refuses stale offline revisions and propagates online failures", async () => {
    await expect(resolvePick(redacted, "a", false, vi.fn(), async () => [
      { ...local, options: ["b", "a", "c", "d"] },
    ])).rejects.toThrow("unavailable offline");
    const fallback = vi.fn();
    await expect(resolvePick(redacted, "a", true, async () => {
      throw new Error("unreachable");
    }, fallback)).rejects.toThrow("unreachable");
    expect(fallback).not.toHaveBeenCalled();
  });
  it("switches a parked online reveal to local grading on disconnect", async () => {
    const unsubscribe = vi.fn();
    const result = await resolvePick(redacted, "a", true,
      () => new Promise(() => {}), async () => [local],
      (offline) => { offline(); return unsubscribe; },
    );
    expect(result).toEqual(local);
    expect(unsubscribe).toHaveBeenCalledOnce();
  });
  it("times out a parked reveal even when the browser remains online", async () => {
    vi.useFakeTimers();
    try {
      const fallback = vi.fn();
      const result = resolvePick(redacted, "a", true, () => new Promise(() => {}), fallback);
      const assertion = expect(result).rejects.toThrow("timed out");
      await vi.advanceTimersByTimeAsync(REVEAL_TIMEOUT_MS);
      await assertion;
      expect(fallback).not.toHaveBeenCalled();
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });
});
