import { defineConfig, devices } from "@playwright/test";

/**
 * E2E runs against a production build, never `next dev`.
 *
 * The app registers a service worker and only in production, so a dev server
 * would leave every install and offline test asserting nothing. It also serves
 * content-hashed chunks, which is what the worker caches. `npm run build` is
 * the webServer command so a stale `.next` cannot quietly pass a test.
 *
 * Chromium only, on purpose: service worker lifecycle, `beforeinstallprompt`
 * and offline emulation are all Chromium-only in Playwright, and those are the
 * tests worth having. Add a firefox/webkit project here when something needs
 * to be proven on more than one engine.
 */
const PORT = Number(process.env.E2E_PORT ?? 3210);
const BASE_URL = `http://127.0.0.1:${PORT}`;

export default defineConfig({
  testDir: "./e2e",
  // The quiz is one question at a time with immediate feedback, so the only
  // slow thing in a spec should be an intentional wait.
  timeout: 30_000,
  expect: { timeout: 7_000 },
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [["github"], ["list"]] : [["list"]],

  use: {
    baseURL: BASE_URL,
    trace: "on-first-retry",
    // A phone-sized viewport: this is a quiz held in one hand, and the
    // install banner is a mobile-only affordance.
    viewport: { width: 390, height: 844 },
    hasTouch: true,
    isMobile: true,
  },

  projects: [{ name: "chromium", use: { ...devices["Pixel 7"] } }],

  webServer: {
    command: `npm run build && npx next start -p ${PORT}`,
    url: BASE_URL,
    reuseExistingServer: !process.env.CI,
    timeout: 180_000,
    stdout: "ignore",
    stderr: "pipe",
  },
});
