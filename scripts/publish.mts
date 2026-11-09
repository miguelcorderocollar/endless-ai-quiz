import { createHash } from "crypto";
import { execFileSync, execSync } from "child_process";

import { checkPublishedBank } from "../src/lib/questions/publishCheck";
import { loadBank, publishedOnly } from "../src/lib/questions/load";

/**
 * Syncs the validated bank to a Convex deployment (issue #27).
 *
 * Usage:
 *   `npx tsx scripts/publish.mts`          # dev deployment (from `.env.local`)
 *   `npx tsx scripts/publish.mts --prod`   # production deployment
 *   `npx tsx scripts/publish.mts --check --prod` # read-only drift warning
 *
 * 1. Loads `content/questions/*.json`, fails on any file error.
 * 2. Fast-path: compares the full-content fingerprint against the target's
 *    published list. Identical content is a no-op (no CLI write at all).
 * 3. Otherwise runs the internal `questions:sync` mutation, which upserts per
 *    stable questionId (insert new, patch changed, archive removed) and is
 *    itself a no-op on an empty diff.
 *
 * Writes go through `npx convex run`, so publishing needs an authenticated
 * CLI (login / deploy key), not just the deployment URL. The mutation is
 * internal and unreachable from the shipped client.
 *
 * Run `npm run validate` first. Publish only from a clean tree.
 */
const toProd = process.argv.includes("--prod");
const runTarget = toProd ? ["--prod"] : [];

function convexRun(fn: string, payload: unknown): string {
  return execFileSync(
    "npx",
    ["convex", "run", fn, JSON.stringify(payload), ...runTarget],
    { encoding: "utf8", maxBuffer: 16 * 1024 * 1024 },
  );
}

/** Canonical form: full content, sorted, source keys normalized. */
function normSource(s: unknown): unknown {
  if (typeof s !== "object" || s === null) return s;
  const o = s as Record<string, unknown>;
  return { kind: o.kind, title: o.title, url: o.url, label: o.label };
}

function fingerprint(
  rows: { questionId: string; text: string; rest: { source: unknown } & Record<string, unknown> }[],
): string {
  const sorted = [...rows]
    .map((r) => ({ ...r, rest: { ...r.rest, source: normSource(r.rest.source) } }))
    .sort((a, b) => (a.questionId < b.questionId ? -1 : 1));
  return createHash("sha1").update(JSON.stringify(sorted)).digest("hex");
}

const { questions, fileErrors } = loadBank();
if (fileErrors.length > 0) {
  for (const e of fileErrors) console.error(`${e.file}: ${e.issues.join("; ")}`);
  console.error("publish aborted: bank has file errors, run `npm run validate`.");
  process.exit(1);
}
const published = publishedOnly(questions);
if (published.length === 0) {
  console.error("publish aborted: no published questions in the bank.");
  process.exit(1);
}

const rows = published.map((q) => ({
  questionId: q.id,
  text: q.text,
  rest: {
    options: q.options,
    answer: q.answer,
    category: q.category,
    difficulty: q.difficulty,
    explanation: q.explanation,
    source: q.source,
    tags: q.tags,
    addedAt: q.addedAt,
  },
}));

// Check mode exits before any CLI invocation or mutation, including on errors.
if (process.argv.includes("--check")) {
  const url = toProd
    ? "https://moonlit-blackbird-812.convex.cloud"
    : process.env.CONVEX_CHECK_URL;
  if (!url) throw new Error("--check needs --prod or CONVEX_CHECK_URL (explicit read target).");
  console.log(`Checking published bank at ${url}`);
  const diff = await checkPublishedBank(published, url);
  if (diff.missing.length || diff.extra.length || diff.changed.length) {
    console.warn(`${process.env.GITHUB_ACTIONS ? "::warning::" : "warning: "}Published bank drift: ${JSON.stringify(diff)}`);
  } else {
    console.log(`Published bank matches git (${published.length} questions).`);
  }
  process.exit(0);
}

// Fast-path: skip the write when the target already matches.
try {
  const raw = convexRun("questions:publishedList", {});
  const remote = JSON.parse(raw) as {
    questionId: string;
    text: string;
    options: string[];
    answer: string;
    category: string;
    difficulty: number;
    explanation: string;
    source: unknown;
    tags: string[];
    addedAt: string;
  }[];
  const remoteRows = remote.map((q) => ({
    questionId: q.questionId,
    text: q.text,
    rest: {
      options: q.options,
      answer: q.answer,
      category: q.category,
      difficulty: q.difficulty,
      explanation: q.explanation,
      source: q.source,
      tags: q.tags,
      addedAt: q.addedAt,
    },
  }));
  if (fingerprint(remoteRows) === fingerprint(rows)) {
    console.log(
      `bank already current on ${toProd ? "prod" : "dev"} (${remote.length} questions), nothing to do.`,
    );
    process.exit(0);
  }
} catch {
  // Unparseable list output: fall through to sync, whose empty diff is a
  // no-op anyway. Keeps the fast-path from ever blocking a publish.
}

let commit: string | undefined;
try {
  const status = execSync("git status --porcelain --untracked-files=no", { encoding: "utf8" }).trim();
  if (status) console.warn("warning: publishing from a dirty tree.");
  commit = execSync("git rev-parse --short HEAD", { encoding: "utf8" }).trim();
} catch {
  /* git metadata is a nicety, not a requirement */
}

const payload = published.map((q) => ({
  questionId: q.id,
  text: q.text,
  options: [...q.options],
  answer: q.answer,
  category: q.category,
  difficulty: q.difficulty,
  explanation: q.explanation,
  source: q.source,
  tags: [...q.tags],
  addedAt: q.addedAt,
}));

// Small batches: `convex run` takes args as one argv string and drops large
// payloads silently, so the whole bank never goes in a single call.
const BATCH = 25;
let inserted = 0;
let updated = 0;
let unchanged = 0;
for (let i = 0; i < payload.length; i += BATCH) {
  const raw = convexRun(
    "questions:sync",
    { commit, questions: payload.slice(i, i + BATCH) },
  );
  const r = JSON.parse(raw) as {
    inserted: number;
    updated: number;
    unchanged: number;
  };
  inserted += r.inserted;
  updated += r.updated;
  unchanged += r.unchanged;
}

const pruned = JSON.parse(
  convexRun("questions:prune", { keepIds: payload.map((q) => q.questionId) }),
) as { archived: number };

const changed = inserted + updated + pruned.archived > 0;
console.log(
  changed
    ? `synced ${toProd ? "prod" : "dev"}: +${inserted} ~${updated} -${pruned.archived} =${unchanged} (${payload.length} published)${commit ? ` at ${commit}` : ""}.`
    : `bank already current on ${toProd ? "prod" : "dev"} (${payload.length} questions), nothing written.`,
);
