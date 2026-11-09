import { questionDigest } from "./digest";
import type { Question } from "./schema";

/**
 * Compares git against answer-free remote digests. Answer changes are not
 * visible here by design (see digest.ts).
 */
export async function diffPublishedBank(local: Question[], remote: unknown) {
  if (!Array.isArray(remote)) throw new Error("Published query did not return an array");
  const byId = new Map<string, string>();
  for (const row of remote) {
    if (typeof row?.questionId !== "string" || typeof row?.digest !== "string") {
      throw new Error("Malformed published digest row");
    }
    if (byId.has(row.questionId)) throw new Error(`Duplicate remote questionId: ${row.questionId}`);
    byId.set(row.questionId, row.digest);
  }
  const localIds = new Set(local.map((q) => q.id));
  const changed: string[] = [];
  for (const q of local) {
    const digest = byId.get(q.id);
    if (digest !== undefined && digest !== (await questionDigest(q))) changed.push(q.id);
  }
  return {
    missing: local.filter((q) => !byId.has(q.id)).map((q) => q.id).sort(),
    extra: [...byId.keys()].filter((id) => !localIds.has(id)).sort(),
    changed: changed.sort(),
  };
}

/** No credentials, CLI, mutations or deploys. Errors must never fall through to sync. */
export async function checkPublishedBank(local: Question[], url: string) {
  const response = await fetch(new URL("/api/query", url), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ path: "questions:publishedDigest", args: {}, format: "json" }),
    signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok) throw new Error(`Published query HTTP ${response.status}`);
  const result = await response.json();
  if (result.status !== "success") throw new Error("Published query failed");
  return diffPublishedBank(local, result.value);
}
