/**
 * Answer-free fingerprint of a published question, for the credential-free
 * drift check (#61). The answer is excluded on purpose: a hash of it would be
 * brute-forceable from the options. Answer drift is only detectable with an
 * authenticated `questions:publishedList` run.
 */
type Digestable = {
  text: string;
  options: string[];
  category: string;
  difficulty: number;
  explanation: string;
  source: { kind: string; title?: string; url?: string; label?: string };
  tags: string[];
  addedAt: string;
};

export async function questionDigest(q: Digestable): Promise<string> {
  const s = q.source;
  const body = JSON.stringify([
    q.text, q.options, q.category, q.difficulty, q.explanation,
    [s.kind, s.title ?? null, s.url ?? null, s.label ?? null], q.tags, q.addedAt,
  ]);
  const bytes = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(body));
  return [...new Uint8Array(bytes)].map((b) => b.toString(16).padStart(2, "0")).join("");
}
