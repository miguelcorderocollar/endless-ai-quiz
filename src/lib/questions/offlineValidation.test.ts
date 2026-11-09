import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { expect, it } from "vitest";

it("offline validation checks cached leads, skips uncached sources and rejects invalid answers", async () => {
  const dir = mkdtempSync(join(tmpdir(), "quiz-offline-"));
  cpSync("content", join(dir, "content"), { recursive: true });
  const run = () => promisify(execFile)(process.execPath, [
    "--import", createRequire(import.meta.url).resolve("tsx"), resolve("scripts/validate.mts"), "--offline",
  ], { cwd: dir });
  try {
    expect((await run()).stdout).toContain("validate passed");
    const files = readdirSync(join(dir, "content/questions"));
    const cachedQuestion = files.flatMap((file) => JSON.parse(readFileSync(join(dir, "content/questions", file), "utf8")))
      .find((row) => row.source.kind === "wikipedia");
    if (!cachedQuestion) throw new Error("No Wikipedia fixture");
    const cacheDir = join(dir, "scripts/.cache/wikipedia");
    mkdirSync(cacheDir, { recursive: true });
    const cacheFile = join(cacheDir, createHash("sha1").update(cachedQuestion.source.title).digest("hex") + ".json");
    const cachedPage = { fetchedAt: new Date().toISOString(), title: cachedQuestion.source.title, intro: "Unrelated cached article lead." };
    writeFileSync(cacheFile, JSON.stringify(cachedPage));
    expect((await run()).stdout).toContain(`${cachedQuestion.id}  weak-grounding  answer absent from cached lead`);
    writeFileSync(cacheFile, JSON.stringify({ ...cachedPage, intro: cachedQuestion.answer }));
    expect((await run()).stdout).not.toContain(`${cachedQuestion.id}  weak-grounding`);
    const file = join(dir, "content/questions", files[0]!);
    const rows = JSON.parse(readFileSync(file, "utf8"));
    rows[0].options = Array(4).fill(rows[0].answer);
    writeFileSync(file, JSON.stringify(rows));
    await expect(run()).rejects.toMatchObject({ code: 1 });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}, 15_000);
