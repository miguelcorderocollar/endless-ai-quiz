import { expect, expectPlaying, installApp, seed, test } from "./fixtures";

/**
 * The offline half of #17: everything that has to be true with no network.
 *
 * Same rules as the rest of the suite — seeded draw cache, Convex cut off —
 * except the specs here *also* cut the page's own network via
 * `context.setOffline`, because the draw failure they exercise only happens
 * when the browser itself cannot reach the server. The one exception is the
 * sync chip, which only needs Convex cut (the page stays online so the chip
 * can prove unsynced answers are visible while playing).
 *
 * Nothing here asserts on real question text: the fallback bank is the live
 * content directory, which changes independently of the app.
 */
test.describe("offline", () => {
  test("a first run with no connection plays from the bundled bank", async ({
    page,
    context,
  }) => {
    await seed(page, { questions: null });
    await page.goto("/");
    await installApp(page);

    await context.setOffline(true);
    await page.goto("/");

    // Not the skeleton, not the empty-bank frame: a real question, from the
    // bundled bank, on a device that has never seen the app before.
    await expectPlaying(page);
    await expect(page.locator("main ul li button")).toHaveCount(4);
    // Answering still works all the way down.
    await page.locator("main ul li button").nth(0).click();
    await expect(page.getByText(/^(correct|not quite)$/)).toBeVisible();

    await context.setOffline(false);
  });

  test("the profile does not hang on a skeleton without a connection", async ({
    page,
    context,
  }) => {
    await seed(page, { questions: null });
    await page.goto("/");
    await installApp(page);

    await context.setOffline(true);
    await page.goto("/profile");

    // Offline, Convex auth never settles, so the loading frame would park in
    // `aria-busy` forever. The page renders the local-only profile instead.
    await expect(page.getByText("Playing as guest", { exact: true })).toBeVisible();
    await expect(page.getByText("elo rating", { exact: true })).toBeVisible();
    await expect(page.locator('[aria-busy="true"]')).toHaveCount(0);

    await context.setOffline(false);
  });

  test("the worker precaches the bundled bank the build generates", async ({
    page,
    request,
  }) => {
    // The offline fallback is a contract between three files that never
    // import each other: `next.config.ts` generates `/bank.json`,
    // `public/sw.js` precaches it by name, and `fallback.ts` fetches it.
    // This pins all three ends.
    const bank = await (await request.get("/bank.json")).json();
    expect(bank.count).toBeGreaterThan(100);
    expect(bank.questions).toHaveLength(bank.count);

    await seed(page, { questions: null });
    await page.goto("/");
    await installApp(page);

    const shell = await page.evaluate(async () => {
      const cache = await caches.open("endless-ai:shell:v2");
      return (await cache.keys()).map((request) => new URL(request.url).pathname);
    });
    expect(shell).toContain("/bank.json");
  });

  test("the masthead says when answers are not reaching the server", async ({
    page,
  }) => {
    await seed(page, {
      outbox: [{ questionId: "con-9001", picked: "Machine learning", account: null, at: 1 }],
    });
    await page.goto("/");
    await expectPlaying(page);

    // The page is online, so "offline" must not show; the parked answer must.
    await expect(page.getByText("1 unsynced", { exact: true })).toBeVisible();
    await expect(page.getByText("offline", { exact: true })).toHaveCount(0);
  });

  test("the masthead says offline when the network is gone", async ({
    page,
    context,
  }) => {
    await seed(page);
    await page.goto("/");
    await expectPlaying(page);

    await context.setOffline(true);
    await expect(page.getByText("offline", { exact: true })).toBeVisible();

    await context.setOffline(false);
    await expect(page.getByText("offline", { exact: true })).toHaveCount(0);
  });

  test("a parked answer survives a reload", async ({ page }) => {
    const rows = [
      { questionId: "con-9001", picked: "Machine learning", account: null, at: 1 },
    ];
    await seed(page, { outbox: rows });
    await page.goto("/");
    await expectPlaying(page);
    await expect(page.getByText("1 unsynced", { exact: true })).toBeVisible();

    await page.reload();
    await expectPlaying(page);
    await expect(page.getByText("1 unsynced", { exact: true })).toBeVisible();

    const stored = await page.evaluate(() =>
      window.localStorage.getItem("endless-ai:answer-outbox:v1"),
    );
    expect(JSON.parse(stored ?? "[]")).toHaveLength(1);
  });
});
