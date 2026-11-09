import type { Page } from "@playwright/test";

import {
  expect,
  expectPlaying,
  installApp,
  offerInstall,
  seed,
  test,
} from "./fixtures";

/** `exact`, because the dismiss button's label also contains "install". */
const installButton = (page: Page) =>
  page.getByRole("button", { name: "install", exact: true });

/**
 * The PWA build: install, offline, and the service worker that makes both work.
 *
 * These run against a production build on purpose. The worker is registered
 * only when `NODE_ENV === "production"` and the chunks it caches are
 * content-hashed, so none of this is observable on a dev server.
 */
test.describe("pwa", () => {
  test("serves a manifest that installs to the home screen", async ({ page, request }) => {
    const manifest = await (await request.get("/manifest.webmanifest")).json();

    expect(manifest.display).toBe("standalone");
    expect(manifest.id).toBe("/");
    expect(manifest.start_url).toBe("/");
    expect(manifest.name).toBe("Endless AI");
    expect(manifest.icons.map((i: { purpose?: string }) => i.purpose)).toContain("maskable");
    // Long-press shortcuts have to be routes that work offline, so the worker
    // precaches them. If one of these ever leaves that list, this fails.
    expect(manifest.shortcuts.map((s: { url: string }) => s.url).sort()).toEqual([
      "/categories",
      "/profile",
    ]);

    await page.goto("/");
    await expect(page.locator('link[rel="manifest"]')).toHaveAttribute(
      "href",
      "/manifest.webmanifest",
    );
    // Next emits only the standard spelling for `appleWebApp.capable` (see the
    // comment in src/app/layout.tsx); iOS also wants Apple's. Both, or an
    // install on an iPhone behaves differently from the one we can test.
    await expect(page.locator('meta[name="mobile-web-app-capable"]')).toHaveAttribute(
      "content",
      "yes",
    );
    await expect(
      page.locator('meta[name="apple-mobile-web-app-capable"]'),
    ).toHaveAttribute("content", "yes");
    await expect(page.locator('meta[name="apple-mobile-web-app-status-bar-style"]')).toHaveAttribute(
      "content",
      "black-translucent",
    );
  });

  test("registers a service worker that takes control and precaches the shell", async ({ page }) => {
    await seed(page);
    await page.goto("/");

    await page.waitForFunction(() => navigator.serviceWorker.controller !== null);
    // The warm-up pass runs inside `activate`, so the worker is still
    // "activating" for a moment after `ready` resolves.
    await expect
      .poll(() =>
        page.evaluate(async () => {
          const registration = await navigator.serviceWorker.getRegistration();
          return registration?.active?.state ?? null;
        }),
      )
      .toBe("activated");

    const state = await page.evaluate(async () => {
      const registration = await navigator.serviceWorker.getRegistration();
      const names = await caches.keys();
      const shell = await caches.open("endless-ai:shell:v2");
      const assets = await caches.open("endless-ai:assets:v2");
      return {
        active: registration?.active?.state ?? null,
        names: names.sort(),
        shell: (await shell.keys()).map((r) => new URL(r.url).pathname).sort(),
        assets: (await assets.keys()).length,
      };
    });

    expect(state.active).toBe("activated");
    expect(state.names).toEqual(["endless-ai:assets:v2", "endless-ai:shell:v2"]);
    expect(state.shell).toEqual(
      expect.arrayContaining(["/", "/categories", "/profile", "/manifest.webmanifest"]),
    );
    // The chunks the precached HTML references. Without this pass the app boots
    // offline to a blank page: the HTML is cached but the scripts never were.
    expect(state.assets).toBeGreaterThan(5);
  });

  test("plays offline from a cold boot", async ({ page, context }) => {
    await seed(page);
    await page.goto("/");
    // Control is not the same as installed: `warmAssetCache()` runs after
    // `clients.claim()`, so cutting the network the moment control flips hands
    // back a document whose scripts were never cached.
    await installApp(page);

    await context.setOffline(true);
    await page.goto("/");

    // Not the skeleton, not the empty-bank frame: the seeded question, drawn
    // from the local snapshot because the draw cannot reach Convex.
    await expectPlaying(page);
    await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
    // Answering still works with no network at all.
    await page.locator("main ul li button").nth(0).click();
    await expect(page.getByText("not quite", { exact: true })).toBeVisible();

    await context.setOffline(false);
  });

  test("navigates to other routes while offline", async ({ page, context }) => {
    await seed(page);
    await page.goto("/");
    // Control is not the same as installed: `warmAssetCache()` runs after
    // `clients.claim()`, so cutting the network the moment control flips hands
    // back a document whose scripts were never cached.
    await installApp(page);

    await context.setOffline(true);

    await page.goto("/categories");
    await expect(page.getByRole("heading", { name: /everything/i })).toBeVisible();

    await page.goto("/profile");
    // Not the header name: offline, Convex auth never settles, so the profile
    // parks on its skeleton forever. The sections below it render regardless,
    // which is what proves the route booted.
    await expect(page.getByText("elo rating", { exact: true })).toBeVisible();
    await expect(page.getByText("app", { exact: true })).toBeVisible();

    await context.setOffline(false);
  });

  test("never caches Convex, so a live question can never be served stale", async ({
    page,
    context,
  }) => {
    await seed(page);
    await page.goto("/");
    // Control is not the same as installed: `warmAssetCache()` runs after
    // `clients.claim()`, so cutting the network the moment control flips hands
    // back a document whose scripts were never cached.
    await installApp(page);

    await context.setOffline(true);

    // A request the worker must not answer. Served from the network handler it
    // fails; cached, it would return a stale question set.
    const result = await page.evaluate(async () => {
      try {
        const response = await fetch(`${location.origin}/api/convex-probe`);
        return response.status;
      } catch {
        return "network-error";
      }
    });

    expect(result).toBe("network-error");

    await context.setOffline(false);
  });
});

test.describe("install prompt", () => {
  test("stays quiet until the player has some history", async ({ page }) => {
    await seed(page, { answered: 9 });
    await page.goto("/");
    await expectPlaying(page);
    await expect(page.getByRole("button", { name: "dismiss install prompt" })).toHaveCount(0);
  });

  test("appears after ten answers and hands off to the browser", async ({ page }) => {
    await seed(page, { answered: 10 });
    await page.goto("/");
    await expectPlaying(page);

    // Chromium fires a real `beforeinstallprompt` on localhost, so the button
    // may already be there. Dispatching our own event makes the click and its
    // assertion deterministic either way.
    await offerInstall(page);

    const install = page.getByRole("button", { name: "install", exact: true });
    await expect(install).toBeVisible();
    await install.click();

    expect(await page.evaluate(() => window.__installPromptShown)).toBe(true);
    // Accepted, so the app is installed and there is nothing left to offer.
    await expect(install).toHaveCount(0);
    await expect(page.getByRole("button", { name: "dismiss install prompt" })).toHaveCount(0);
  });

  test("a refusal is remembered", async ({ page }) => {
    await seed(page, { answered: 10 });
    await page.goto("/");
    await expectPlaying(page);
    await offerInstall(page);

    await page.getByRole("button", { name: "dismiss install prompt" }).click();
    await expect(installButton(page)).toHaveCount(0);

    await page.reload();
    await expectPlaying(page);
    await offerInstall(page);
    await expect(installButton(page)).toHaveCount(0);

    // Refusing the banner is not refusing the app: the profile still offers it.
    await page.goto("/profile");
    await expect(page.getByText("app", { exact: true })).toBeVisible();
    await offerInstall(page);
    await expect(installButton(page)).toBeVisible();
  });

  test("the profile keeps a permanent way to install", async ({ page }) => {
    await seed(page);
    await page.goto("/profile");
    await expect(page.getByText("app", { exact: true })).toBeVisible();

    // No engagement gate here: this is the row a player goes looking for, so
    // it is on screen from a cold, zero-answer visit, where the quiz banner
    // would not be.
    await offerInstall(page);
    await expect(installButton(page)).toBeVisible();
  });
});
