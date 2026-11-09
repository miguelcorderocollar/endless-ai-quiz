import { execFile } from "node:child_process";
import { cpSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { expect, it } from "vitest";

it("offline validation needs no Wikipedia cache but still rejects invalid answers", async () => {
  const dir = mkdtempSync(join(tmpdir(), "quiz-offline-"));
  cpSync("content", join(dir, "content"), { recursive: true });
  const run = () => promisify(execFile)(process.execPath, [
    "--import", createRequire(import.meta.url).resolve("tsx"), resolve("scripts/validate.mts"), "--offline",
  ], { cwd: dir });
  try {
    expect((await run()).stdout).toContain("validate passed");
    const file = join(dir, "content/questions", readdirSync(join(dir, "content/questions"))[0]!);
    const rows = JSON.parse(readFileSync(file, "utf8"));
    rows[0].options = Array(4).fill(rows[0].answer);
    writeFileSync(file, JSON.stringify(rows));
    await expect(run()).rejects.toMatchObject({ code: 1 });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}, 15_000);
