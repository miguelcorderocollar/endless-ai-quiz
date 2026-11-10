import { createHash } from "crypto";

import { type WikiIntroResult, fetchFullText, resolveIntros } from "./lib/wikipedia.mts";

import { loadBank } from "../src/lib/questions/load";
import { checkNativeBank } from "./lib/nativeBank.mts";
import {
  CATEGORIES,
  CATEGORY_KEYS,
  PREFIX_BY_KEY,
  type Question,
  lengthViolations,
} from "../src/lib/questions/schema";

const OFFLINE = process.argv.includes("--offline");

type Issue = { level: "error" | "warn"; id: string; rule: string; message: string };

const issues: Issue[] = [];
const err = (id: string, rule: string, message: string) =>
  issues.push({ level: "error", id, rule, message });
const warn = (id: string, rule: string, message: string) =>
  issues.push({ level: "warn", id, rule, message });

/* ------------------------------------------------------------------ *
 * normalization helpers
 * ------------------------------------------------------------------ */

const normalize = (s: string) =>
  s
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .toLowerCase()
    .replace(/['']/g, "'")
    .replace(/\s+/g, " ")
    .trim();

const hash = (s: string) => createHash("sha1").update(normalize(s)).digest("hex");

const FILLER = [
  "all of the above",
  "none of the above",
  "all of these",
  "none of these",
];

const VOLATILE = [
  "most recent",
  "currently",
  "right now",
  "today",
  "best model",
  "most capable",
  "state of the art",
  "state-of-the-art",
  "largest",
  "leading",
  "as of 20",
];

/* ------------------------------------------------------------------ *
 * rule 1 to 4: shape, integrity, distractors
 * ------------------------------------------------------------------ */

function checkShape(q: Question, idCount: Map<string, number>) {
  for (const message of lengthViolations(q)) err(q.id, "too-long", message);

  const optionSet = new Set(q.options.map(normalize));
  if (optionSet.size !== q.options.length) {
    err(q.id, "duplicate-option", "two options are identical once normalized");
  }

  const matches = q.options.filter((o) => o === q.answer).length;
  if (matches !== 1) {
    err(
      q.id,
      "answer-integrity",
      `answer must match exactly one option, matched ${matches}. Copy the option string character for character.`,
    );
  }

  const questionHash = hash(q.text);
  idCount.set(questionHash, (idCount.get(questionHash) ?? 0) + 1);

  const prefix = q.id.split("-")[0];
  if (prefix !== PREFIX_BY_KEY[q.category]) {
    err(
      q.id,
      "id-prefix",
      `id prefix "${prefix}" does not match category "${q.category}" (expected "${PREFIX_BY_KEY[q.category]}")`,
    );
  }

  for (const option of q.options) {
    const lower = option.toLowerCase();
    for (const phrase of FILLER) {
      if (lower.includes(phrase)) {
        err(q.id, "filler-option", `option contains filler phrase "${phrase}"`);
      }
    }
  }

  const sorted = [...q.options].map(normalize).sort();
  for (let i = 0; i < sorted.length; i++) {
    for (let j = i + 1; j < sorted.length; j++) {
      const a = sorted[i]!;
      const b = sorted[j]!;
      if (a.length > 4 && (a.includes(b) || b.includes(a))) {
        err(q.id, "superstring-option", `"${a}" and "${b}" are too similar to be options`);
      }
    }
  }
}

function checkDistractors(q: Question, lengthStats: { correct: number[]; other: number[] }) {
  const correct = q.answer;
  const others = q.options.filter((o) => o !== correct);
  if (others.length === 0) return;

  lengthStats.correct.push(correct.length);
  for (const other of others) lengthStats.other.push(other.length);

  // A bare quantity is what gives a question away when three of its options are prose.
  const QUANTITY = /^\s*\d[\d,.]*\s*(million|billion|trillion|thousand|percent|%)?\s*$/i;
  const quantities = q.options.filter((o) => QUANTITY.test(o)).length;
  if (quantities > 0 && quantities !== q.options.length) {
    err(
      q.id,
      "mixed-option-types",
      "one or more options are bare quantities while the rest are prose, so the player can eliminate by shape",
    );
  }
}

function checkVolatility(q: Question) {
  const haystack = `${q.text} ${q.answer}`.toLowerCase();
  for (const phrase of VOLATILE) {
    if (haystack.includes(phrase)) {
      warn(q.id, "volatility", `looks time sensitive ("${phrase}"), this fact will rot`);
    }
  }
  if (/\b(2024|2025|2026)\b/.test(haystack) && !/\b(19|20)\d{2}\b/.test(q.explanation)) {
    warn(q.id, "recency", "question references a recent year, confirm it will stay true");
  }
}

/* ------------------------------------------------------------------ *
 * rule 5: source grounding
 * ------------------------------------------------------------------ */

async function checkUrlSources(questions: Question[]) {
  for (const q of questions) {
    if (q.source.kind !== "url") continue;
    const head = () =>
      fetch(q.source.url, {
        method: "HEAD",
        redirect: "follow",
        headers: { "User-Agent": "EndlessAI-QuestionValidator/0.1 (content QA)" },
      });
    try {
      // One retry on a network error only. A real HTTP status is final, but a
      // single dropped connection should not fail the whole gate.
      const res = await head().catch(() => head());
      if (!res.ok) err(q.id, "dead-source", `${q.source.url} returned ${res.status}`);
    } catch (fetchErr) {
      err(q.id, "dead-source", `${q.source.url} is unreachable: ${(fetchErr as Error).message}`);
    }
  }
}

const misses: Question[] = [];

function checkGrounding(q: Question, page: WikiIntroResult) {
  if (!page.ok) {
    err(q.id, "ungrounded", `wikipedia check failed, ${page.reason}`);
    return;
  }

  const candidates = [q.answer, ...q.answerAliases].map(normalize).filter(Boolean);
  if (candidates.some((c) => normalize(page.intro).includes(c))) return;
  misses.push(q);
}

/** Lead section misses are only a warning if the answer is somewhere in the article body. */
async function softenMisses() {
  for (const q of misses) {
    if (q.source.kind !== "wikipedia") continue;
    const text = await fetchFullText(q.source.title);
    if (!text) {
      err(q.id, "ungrounded", `could not read the full article for "${q.source.title}"`);
      continue;
    }
    const haystack = normalize(text);
    const candidates = [q.answer, ...q.answerAliases].map(normalize).filter(Boolean);
    if (candidates.some((c) => haystack.includes(c))) {
      warn(
        q.id,
        "weak-grounding",
        `the answer is in "${q.source.title}" but not in the lead section, so confirm this page really supports the claim`,
      );
    } else {
      err(
        q.id,
        "ungrounded",
        `the answer appears nowhere in "${q.source.title}". Either the answer is wrong, this is the wrong page, or answerAliases is missing the form the page uses.`,
      );
    }
  }
}

/* ------------------------------------------------------------------ *
 * rule 3 and 7: corpus level checks
 * ------------------------------------------------------------------ */

function checkPositionBalance(questions: Question[]) {
  const counts = [0, 0, 0, 0];
  for (const q of questions) {
    const index = q.options.indexOf(q.answer);
    if (index >= 0) counts[index] += 1;
  }
  const total = questions.length;
  if (total < 20) return;

  for (let i = 0; i < 4; i++) {
    const share = counts[i]! / total;
    if (share > 0.4) {
      err(
        "corpus",
        "answer-position",
        `the answer sits in slot ${"ABCD"[i]} ${(share * 100).toFixed(0)}% of the time, over the 40% limit`,
      );
    }
  }
}

function checkLengthBias(questions: Question[]) {
  const correct: number[] = [];
  const other: number[] = [];
  for (const q of questions) {
    checkDistractors(q, { correct, other });
  }
  const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / Math.max(1, xs.length);
  if (correct.length < 20) return;

  const ratio = mean(correct) / Math.max(1, mean(other));
  if (ratio > 1.25) {
    err(
      "corpus",
      "answer-length",
      `the correct answer averages ${ratio.toFixed(2)}x the length of a wrong option, so length gives the answer away`,
    );
  }
}

function report(questions: Question[]) {
  const published = questions.filter((q) => q.status === "published");

  console.log("\nCoverage\n");
  console.log("  category     published   all   d1  d2  d3  d4  d5");
  for (const category of CATEGORIES) {
    const all = questions.filter((q) => q.category === category.key);
    const pub = all.filter((q) => q.status === "published");
    const diff = [1, 2, 3, 4, 5].map(
      (d) => pub.filter((q) => q.difficulty === d).length,
    );
    console.log(
      `  ${category.key.padEnd(12)} ${String(pub.length).padStart(9)} ${String(all.length).padStart(5)}  ${diff
        .map((n) => String(n).padStart(2))
        .join("  ")}`,
    );
  }

  const positions = [0, 0, 0, 0];
  for (const q of published) {
    const i = q.options.indexOf(q.answer);
    if (i >= 0) positions[i] += 1;
  }

  const byKind = { wikipedia: 0, url: 0, none: 0 } as Record<string, number>;
  for (const q of published) byKind[q.source.kind] = (byKind[q.source.kind] ?? 0) + 1;
  const sourced = published.length - (byKind.none ?? 0);
  const sourcePct = published.length ? (sourced / published.length) * 100 : 0;

  console.log("\nBank health\n");
  console.log(`  total questions      ${questions.length}`);
  console.log(`  published            ${published.length}`);
  console.log(`  answer slots         ${positions.map((n, i) => `${"ABCD"[i]}=${n}`).join("  ")}`);
  console.log(`  wikipedia source     ${byKind.wikipedia ?? 0}`);
  console.log(`  url source           ${byKind.url ?? 0}`);
  console.log(`  no source            ${byKind.none ?? 0}`);
  console.log(
    `  verified coverage    ${sourcePct.toFixed(1)}%${sourcePct >= 90 ? "" : "   (target is 90%)"}`,
  );
  const thin = CATEGORIES.filter(
    (c) => published.filter((q) => q.category === c.key).length < 150,
  );
  if (thin.length && published.length) {
    console.log(`  below 150 target     ${thin.map((c) => c.key).join(", ")}`);
  }
}

/* ------------------------------------------------------------------ *
 * main
 * ------------------------------------------------------------------ */

async function main() {
  const { questions, fileErrors } = loadBank();

  for (const fileError of fileErrors) {
    issues.push({
      level: "error",
      id: fileError.file,
      rule: "schema",
      message: fileError.issues.join(" | "),
    });
  }

  // The native app's committed bank (#18). A question change that does not
  // reach `apps/mobile/assets/bank.json` ships a phone app that plays a
  // different bank than the web, so it is an error here rather than a warning.
  const nativeBankStale = checkNativeBank(new URL("..", import.meta.url).pathname);
  if (nativeBankStale) {
    issues.push({
      level: "error",
      id: "apps/mobile/assets/bank.json",
      rule: "native-bank",
      message: nativeBankStale,
    });
  }

  const idCount = new Map<string, number>();
  const lengthStats = { correct: [] as number[], other: [] as number[] };

  for (const q of questions) {
    checkShape(q, idCount);
    checkDistractors(q, lengthStats);
    checkVolatility(q);
  }

  for (const [questionHash, count] of idCount) {
    if (count > 1) {
      err("corpus", "duplicate-question", `question text appears ${count} times (${questionHash.slice(0, 8)})`);
    }
  }

  checkPositionBalance(questions);
  checkLengthBias(questions);

  if (questions.length) {
    const titles = [
      ...new Set(
        questions
          .filter((q) => q.source.kind === "wikipedia")
          .map((q) => (q.source.kind === "wikipedia" ? q.source.title : "")),
      ),
    ];
    process.stdout.write(
      `Grounding ${questions.length} questions against ${titles.length} wikipedia articles`,
    );
    const pages = await resolveIntros(titles, OFFLINE);
    for (const q of questions) {
      process.stdout.write(".");
      if (q.source.kind === "wikipedia") {
        const page = pages.get(q.source.title);
        if (!OFFLINE || page?.ok) {
          checkGrounding(q, page ?? { ok: false, reason: "not checked" });
        }
      } else if (q.source.kind === "none" && q.explanation.length < 60) {
        err(
          q.id,
          "ungrounded",
          "no source, so the explanation has to carry the whole thing on its own and is too short",
        );
      }
    }
    process.stdout.write("\n");
    if (OFFLINE) {
      for (const q of misses) {
        warn(q.id, "weak-grounding", "answer absent from cached lead; full article not checked (offline mode)");
      }
    } else {
      await softenMisses();
      await checkUrlSources(questions);
    }
  }

  report(questions);

  const errors = issues.filter((i) => i.level === "error");
  const warnings = issues.filter((i) => i.level === "warn");

  if (warnings.length) {
    console.log(`\nWarnings (${warnings.length})`);
    for (const w of warnings) console.log(`  ${w.id}  ${w.rule}  ${w.message}`);
  }

  if (errors.length) {
    console.log(`\nErrors (${errors.length})`);
    for (const e of errors) console.log(`  ${e.id}  ${e.rule}  ${e.message}`);
    console.log("\nvalidate FAILED\n");
    process.exit(1);
  }

  if (!questions.length) {
    console.log("\nNo questions found. Add JSON files under content/questions/.\n");
    process.exit(1);
  }

  console.log("\nvalidate passed\n");
}

await main();

export { CATEGORY_KEYS };
