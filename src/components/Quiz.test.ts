// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getFunctionName } from "convex/server";
import { Quiz } from "./Quiz";
import type { Question } from "@/lib/questions/schema";
import { QuizFromConvex } from "./QuizFromConvex";
import { EMPTY_PROGRESS, readProgress, updateProgress } from "@/lib/progress";
import { REVEAL_TIMEOUT_MS } from "@/lib/questions/resolvePick";

const mocks = vi.hoisted(() => ({
  query: vi.fn(), reveal: vi.fn(), record: vi.fn(), fallback: vi.fn(),
}));
vi.mock("convex/react", () => ({
  useConvex: () => client,
  useConvexAuth: () => ({ isAuthenticated: false }),
  useQuery: () => undefined,
  useMutation: (ref: Parameters<typeof getFunctionName>[0]) =>
    getFunctionName(ref) === "answers:reveal" ? mocks.reveal : mocks.record,
}));
vi.mock("next/link", () => ({ default: "a" }));
vi.mock("./InstallPrompt", () => ({ InstallBanner: () => null }));
vi.mock("./SyncStatus", () => ({ SyncStatus: () => null }));
vi.mock("./UpdatePrompt", () => ({ UpdatePrompt: () => null }));
vi.mock("@/lib/questions/fallback", () => ({ loadFallbackBank: mocks.fallback }));
const client = { query: mocks.query };

let root: Root;
let host: HTMLDivElement;
let sequence = 0;

function button(text: string) {
  const found = [...host.querySelectorAll("button")].find((b) => b.textContent?.includes(text));
  if (!found) throw new Error(`Missing button: ${text}`);
  return found;
}
async function click(text: string) {
  await act(async () => { button(text).click(); });
}
async function draw() {
  // Unique ids prevent the intentionally persistent quiz session from restoring another test.
  const row = {
    questionId: `con-${++sequence}`, text: `Online question ${sequence}?`,
    options: ["Wrong option", "Right option", "Third option", "Fourth option"],
    category: "concepts", difficulty: 2, tags: [], addedAt: "2026-01-01",
  };
  mocks.query.mockResolvedValueOnce([row]);
  await act(async () => { root.render(createElement(QuizFromConvex)); });
  expect(getFunctionName(mocks.query.mock.calls[0]![0])).toBe("questions:drawForPlay");
  expect(host.querySelector("h1")?.textContent).toBe(row.text);
  expect(host.textContent).not.toContain("Server explanation");
  const cache = window.localStorage.getItem("endless-ai:draw-cache:v1:all");
  expect(JSON.parse(cache!).questions[0].answer).toBe("");
  return row;
}

beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  vi.clearAllMocks();
  Object.defineProperty(window.navigator, "onLine", { configurable: true, value: true });
  window.dispatchEvent(new Event("online"));
  // Node 26 exposes an unavailable localStorage global that Vitest can copy
  // over jsdom's storage. Use a fresh Storage implementation for each mount.
  const storage = new Map<string, string>();
  Object.defineProperty(window, "localStorage", { configurable: true, value: {
    getItem: (key: string) => storage.get(key) ?? null,
    setItem: (key: string, value: string) => { storage.set(key, value); },
    removeItem: (key: string) => { storage.delete(key); },
    clear: () => storage.clear(),
  } });
  updateProgress({ ...EMPTY_PROGRESS });
  mocks.fallback.mockResolvedValue([]);
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => { root.unmount(); });
  host.remove();
  vi.useRealTimers();
});

describe("online web draw and reveal", () => {
  it("shows submitting, blocks duplicate picks, then renders server feedback", async () => {
    let finish!: (value: unknown) => void;
    mocks.reveal.mockReturnValue(new Promise((resolve) => { finish = resolve; }));
    const row = await draw();
    await click("Wrong option");
    expect(mocks.reveal).toHaveBeenCalledWith({ questionId: row.questionId, picked: "Wrong option" });
    expect(host.querySelector('[role="status"]')?.textContent).toBe("Checking answer…");
    expect([...host.querySelectorAll("main ul button")].every((b) => (b as HTMLButtonElement).disabled)).toBe(true);
    await click("Right option");
    expect(mocks.reveal).toHaveBeenCalledTimes(1);
    expect(readProgress().answered).toBe(0);
    await act(async () => {
      finish({ correct: false, answer: "Right option", explanation: "Server explanation", source: { kind: "none" } });
    });
    expect(host.querySelector('[role="status"]')).toBeNull();
    expect(host.textContent).toContain("not quite");
    expect(host.textContent).toContain("Server explanation");
    expect(button("next")).toBeTruthy();
    expect(readProgress().answered).toBe(1);
    expect(readProgress().correct).toBe(0);
    expect(mocks.fallback).not.toHaveBeenCalled();
  });

  it("allows skipping an archived question after a terminal reveal error", async () => {
    mocks.reveal.mockRejectedValue(new Error("Unknown question."));
    const row = await draw();
    const next = { ...row, questionId: `con-${++sequence}`, text: "Next online question?" };
    mocks.query.mockResolvedValueOnce([next]);
    await click("Wrong option");
    expect(host.querySelector('[role="alert"]')?.textContent).toContain("Try again or skip");
    expect(host.querySelector('[role="status"]')).toBeNull();
    await click("skip this question");
    expect(host.querySelector("h1")?.textContent).toBe(next.text);
    expect(host.querySelector('[role="alert"]')).toBeNull();
    expect(readProgress().answered).toBe(0);
    expect(mocks.query.mock.calls[1]![1].excludeIds).toContain(row.questionId);
  });

  it("lets the player retry or skip a parked reveal after the timeout", async () => {
    vi.useFakeTimers();
    let finish!: (value: unknown) => void;
    mocks.reveal.mockReturnValue(new Promise((resolve) => { finish = resolve; }));
    await draw();
    await click("Wrong option");
    await act(async () => { await vi.advanceTimersByTimeAsync(REVEAL_TIMEOUT_MS); });
    expect(host.querySelector('[role="status"]')).toBeNull();
    expect(host.querySelector('[role="alert"]')).not.toBeNull();
    expect(button("skip this question").disabled).toBe(false);
    expect(button("Wrong option").disabled).toBe(false);
    await act(async () => {
      finish({ correct: false, answer: "Right option", explanation: "Late explanation", source: { kind: "none" } });
    });
    expect(host.textContent).not.toContain("Late explanation");
    expect(readProgress().answered).toBe(0);
  });

  it("allows skipping when the offline bundle has different text", async () => {
    Object.defineProperty(window.navigator, "onLine", { configurable: true, value: false });
    window.dispatchEvent(new Event("offline"));
    const question: Question = {
      id: `con-${++sequence}`, text: "Cached text?", options: ["a", "b", "c", "d"],
      answer: "", explanation: "", source: { kind: "none" }, category: "concepts",
      difficulty: 2, tags: [], answerAliases: [], status: "published", addedAt: "2026-01-01",
    };
    const next = { ...question, id: `con-${++sequence}`, text: "Next cached question?" };
    mocks.fallback.mockResolvedValue([{ ...question, text: "Changed bundled text?", answer: "a" }]);
    await act(async () => { root.render(createElement(Quiz, {
      bank: [question, next], initial: question, categories: new Set<Question["category"]>(), onNeedMore: async () => [],
    })); });
    await click("a");
    expect(host.querySelector('[role="alert"]')).not.toBeNull();
    await click("skip this question");
    expect(host.querySelector("h1")?.textContent).toBe(next.text);
    expect(readProgress().answered).toBe(0);
    expect(mocks.reveal).not.toHaveBeenCalled();
  });
});
