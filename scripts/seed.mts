import { ConvexHttpClient } from "convex/browser";

import { loadBank, publishedOnly } from "../src/lib/questions/load.js";
import { api } from "../convex/_generated/api.js";

/**
 * Seeds dummy players for stats development (#11).
 * Usage: npx tsx scripts/seed.mts [--url <convex-url>] [--users N] [--answers K]
 *
 * Each seed signs up as seed{n}@seed.endless-ai.test, gets a spread of skill
 * (45–85% base accuracy) with per-category strengths/weaknesses so Elo,
 * category bars, and the population distribution look alive. Cleanup:
 * npx convex run seed:cleanupSeed [--deployment prod]
 */
function argValue(flag: string, fallback: string): string {
  const i = process.argv.indexOf(flag);
  return i >= 0 ? (process.argv[i + 1] ?? fallback) : fallback;
}

const url =
  argValue("--url", "") ||
  process.env.CONVEX_URL ||
  "https://careful-salmon-552.convex.cloud";
const USER_COUNT = Number(argValue("--users", "12"));
const ANSWERS_EACH = Number(argValue("--answers", "80"));
const PASSWORD = "Seedtest123!";

const rand = (min: number, max: number) => min + Math.random() * (max - min);
const pick = <T>(arr: T[]): T => arr[Math.floor(Math.random() * arr.length)]!;

// Seeding is local tooling; the full-bank endpoint is now admin-only.
const bank = publishedOnly(loadBank().questions).map((q) => ({ ...q, questionId: q.id }));
if (bank.length === 0) throw new Error("Bank is empty, publish first.");
const categories = [...new Set(bank.map((q) => q.category))];
console.log(`bank: ${bank.length} questions, ${categories.length} categories`);

for (let i = 0; i < USER_COUNT; i++) {
  const email = `seed${i}@seed.endless-ai.test`;
  const guest = new ConvexHttpClient(url);
  const signed = await guest.action(api.auth.signIn, {
    provider: "password",
    params: { email, password: PASSWORD, flow: "signUp" },
  } as never);
  const authed = new ConvexHttpClient(url);
  authed.setAuth(
    (signed as { tokens: { token: string } }).tokens.token,
  );
  await authed.mutation(api.users.ensureProfile, {});

  const skill = rand(0.45, 0.85);
  const strong = new Set([pick(categories), pick(categories)]);
  const weak = new Set([pick(categories), pick(categories)]);
  let correct = 0;
  for (let a = 0; a < ANSWERS_EACH; a++) {
    const q = pick(bank);
    let p = skill;
    if (strong.has(q.category)) p = Math.min(0.97, skill + 0.2);
    if (weak.has(q.category)) p = Math.max(0.15, skill - 0.25);
    const hit = Math.random() < p;
    if (hit) correct++;
    await authed.mutation(api.answers.answer, {
      questionId: q.questionId,
      picked: hit ? q.answer : pick(q.options.filter((o) => o !== q.answer)),
    });
  }
  const stats = await authed.query(api.answers.myStats, {});
  console.log(
    `${email}: ${correct}/${ANSWERS_EACH} picked-right, rating ${stats?.rating}, streak ${stats?.streak}`,
  );
}
console.log("done. cleanup: npx convex run seed:cleanupSeed [--deployment prod]");
