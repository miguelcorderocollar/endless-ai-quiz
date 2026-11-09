import { questionSchema, type Question } from "./schema";

/** Compare only publishable content, excluding Convex metadata and git-only fields. */
function content(q: Question): string {
  const source = q.source;
  return JSON.stringify([
    q.text, q.options, q.answer, q.category, q.difficulty, q.explanation,
    [source.kind, "title" in source ? source.title : null,
      "url" in source ? source.url : null, "label" in source ? source.label : null],
    q.tags, q.addedAt,
  ]);
}

export function diffPublishedBank(local: Question[], remote: unknown) {
  if (!Array.isArray(remote)) throw new Error("Published query did not return an array");
  const byId = new Map<string, Question>();
  for (const row of remote) {
    const q = questionSchema.parse({ ...row, id: row.questionId, status: "published" });
    if (byId.has(q.id)) throw new Error(`Duplicate remote questionId: ${q.id}`);
    byId.set(q.id, q);
  }
  const localIds = new Set(local.map((q) => q.id));
  return {
    missing: local.filter((q) => !byId.has(q.id)).map((q) => q.id).sort(),
    extra: [...byId.keys()].filter((id) => !localIds.has(id)).sort(),
    changed: local.filter((q) => byId.has(q.id) && content(q) !== content(byId.get(q.id)!))
      .map((q) => q.id).sort(),
  };
}

/** No credentials, CLI, mutations or deploys. Errors must never fall through to sync. */
export async function checkPublishedBank(local: Question[], url: string) {
  const response = await fetch(new URL("/api/query", url), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ path: "questions:list", args: {}, format: "json" }),
    signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok) throw new Error(`Published query HTTP ${response.status}`);
  const result = await response.json();
  if (result.status !== "success") throw new Error("Published query failed");
  return diffPublishedBank(local, result.value);
}
