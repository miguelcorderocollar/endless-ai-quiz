import { execFile } from "node:child_process";
import { createServer } from "node:http";
import { promisify } from "node:util";
import { afterEach, expect, it, vi } from "vitest";

import { loadBank, publishedOnly } from "./load";
import { questionDigest } from "./digest";
import { checkPublishedBank, diffPublishedBank } from "./publishCheck";

const questions = publishedOnly(loadBank().questions);
const q = questions[0]!;
const remote = async (question = q) => ({ questionId: question.id, digest: await questionDigest(question) });
afterEach(() => vi.unstubAllGlobals());

it("ignores order", async () => {
  const rows = (await Promise.all(questions.map((x) => remote(x)))).reverse();
  expect(await diffPublishedBank(questions, rows)).toEqual({ missing: [], extra: [], changed: [] });
});

it("reports missing, extra and changed publishable content", async () => {
  const other = { ...q, id: "hst-9999" };
  expect(await diffPublishedBank([q, other], [await remote({ ...q, text: "changed" }), await remote({ ...q, id: "hst-9998" })]))
    .toEqual({ missing: ["hst-9999"], extra: ["hst-9998"], changed: [q.id] });
  // Answers are deliberately not fingerprinted.
  expect((await diffPublishedBank([q], [await remote({ ...q, answer: "changed" })])).changed).toEqual([]);
  for (const field of ["text", "category", "difficulty", "explanation", "source", "tags", "addedAt", "options"] as const) {
    const alternative = questions.find((row) => JSON.stringify(row[field]) !== JSON.stringify(q[field]));
    if (!alternative) throw new Error(`No distinct fixture for ${field}`);
    const changed = { ...q, [field]: alternative[field] };
    expect((await diffPublishedBank([q], [await remote(changed)])).changed).toEqual([q.id]);
  }
});

it("rejects duplicate and malformed remote rows", async () => {
  await expect(diffPublishedBank([q], [await remote(), await remote()])).rejects.toThrow("Duplicate");
  await expect(diffPublishedBank([q], [{}])).rejects.toThrow();
  await expect(diffPublishedBank([q], null)).rejects.toThrow();
});

it("uses only an unauthenticated query and fails on HTTP or query errors", async () => {
  const fetcher = vi.fn().mockResolvedValue(new Response(JSON.stringify({ status: "success", value: [await remote()] })));
  vi.stubGlobal("fetch", fetcher);
  await checkPublishedBank([q], "https://example.invalid");
  expect(fetcher).toHaveBeenCalledWith(new URL("https://example.invalid/api/query"), expect.objectContaining({
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ path: "questions:publishedDigest", args: {}, format: "json" }),
  }));
  fetcher.mockResolvedValue(new Response("unavailable", { status: 503 }));
  await expect(checkPublishedBank([q], "https://example.invalid")).rejects.toThrow("HTTP 503");
  fetcher.mockResolvedValue(new Response(JSON.stringify({ status: "error" })));
  await expect(checkPublishedBank([q], "https://example.invalid")).rejects.toThrow("query failed");
});

it("CLI check exits on drift and on query failure without invoking the Convex CLI", async () => {
  let failure = false;
  const requests: string[] = [];
  const server = createServer((req, res) => {
    requests.push(req.url!);
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify(failure ? { status: "error" } : { status: "success", value: [] }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address() as { port: number };
  try {
    const run = (githubActions = false) => promisify(execFile)(process.execPath, ["--import", "tsx", "scripts/publish.mts", "--check"], {
      // No npx on PATH. Any fall-through to the publish path must fail.
      env: { ...process.env, GITHUB_ACTIONS: githubActions ? "true" : "", PATH: "/nonexistent", CONVEX_CHECK_URL: `http://127.0.0.1:${address.port}` },
    });
    expect((await run()).stderr).toContain("Published bank drift");
    expect((await run(true)).stderr).toContain("::warning::Published bank drift:");
    failure = true;
    await expect(run()).rejects.toMatchObject({ code: 1 });
    expect(requests).toEqual(["/api/query", "/api/query", "/api/query"]);
  } finally {
    server.close();
  }
}, 15_000);
