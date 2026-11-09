import { expect, installApp, seed, test } from "./fixtures";

for (const hung of [false, true]) {
test(`sign-out clears the guest profile with ${hung ? "a hung" : "a successful"} reply`, async ({ page, context }) => {
  await seed(page);
  // Keep auth unresolved with a fake local token. Only sign-out gets a reply;
  // all queries stay parked, and no socket is forwarded to a deployment.
  await page.routeWebSocket(/convex/, socket => {
    socket.onMessage(raw => {
      const message = JSON.parse(String(raw));
      if (!hung && message.type === "Action" && message.udfPath === "auth:signOut") {
        socket.send(JSON.stringify({ type: "ActionResponse", requestId: message.requestId, success: true, result: null, logLines: [] }));
      }
    });
  });
  await page.goto("/");
  await installApp(page);
  // Cached signed-in profile on an offline device. No live auth or deployment.
  await page.evaluate(url => {
    localStorage.setItem(`__convexAuthJWT_${url.replace(/[^a-zA-Z0-9]/g, "")}`, `e30.${btoa(JSON.stringify({ sub: "fake-user", exp: 4102444800, iat: 1 }))}.fake`);
    localStorage.setItem("endless-ai:answer-outbox:v1", JSON.stringify([
      { eventId: "a", account: "alice", questionId: "con-9001", picked: "answer", at: 1 },
      { eventId: "legacy", account: null, questionId: "con-9001", picked: "answer", at: 2 },
    ]));
    localStorage.setItem("endless-ai:profile:v1", JSON.stringify({ displayName: "Private player", handle: "alice", role: "user", isAnonymous: false }));
    localStorage.setItem("endless-ai:progress:v1", JSON.stringify({ rating: 1900, answered: 42, correct: 30, completed: ["private-question"], recent: [], streak: 5, lastPlayed: "2026-11-09" }));
  }, process.env.NEXT_PUBLIC_CONVEX_URL ?? "https://offline-test.convex.cloud");
  await context.setOffline(true);
  await page.goto("/profile");
  await expect(page.getByText("Private player", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "sign out", exact: true }).click();
  await page.waitForURL("/");
  await expect(page.getByText("2 unsynced answers remain on this device for this account. Sign in again to sync them.", { exact: false })).toBeVisible();
  await page.goto("/profile");
  await expect(page.getByText("Playing as guest", { exact: true })).toBeVisible();
  await expect(page.getByText("Private player", { exact: true })).toHaveCount(0);
  await expect(page.getByText("1000", { exact: true })).toBeVisible();
  const saved = await page.evaluate(() => JSON.parse(localStorage.getItem("endless-ai:progress:v1")!));
  expect(saved).toMatchObject({ rating: 1000, answered: 0, correct: 0, completed: [], recent: [] });
  await context.setOffline(false);
});
}

test("another tab clears its live progress when the account token is removed", async ({ page, context }) => {
  await seed(page);
  await page.goto("/");
  await installApp(page);
  const tokenKey = `__convexAuthJWT_${(process.env.NEXT_PUBLIC_CONVEX_URL ?? "https://offline-test.convex.cloud").replace(/[^a-zA-Z0-9]/g, "")}`;
  await page.evaluate(key => {
    localStorage.setItem(key, `e30.${btoa(JSON.stringify({ sub: "fake-user", exp: 4102444800, iat: 1 }))}.fake`);
    localStorage.setItem("endless-ai:progress:v1", JSON.stringify({ rating: 1900, answered: 42, correct: 30, completed: [], recent: [] }));
  }, tokenKey);
  const other = await context.newPage();
  await seed(other);
  await other.goto("/");
  await expect(other.getByText("1900", { exact: true })).toBeVisible();
  const reloaded = other.waitForEvent("load");
  await page.evaluate(key => localStorage.removeItem(key), tokenKey);
  await reloaded;
  await expect(other.getByText("1000", { exact: true })).toBeVisible();
  expect(await other.evaluate(() => JSON.parse(localStorage.getItem("endless-ai:progress:v1")!).answered)).toBe(0);
  await other.close();
});
