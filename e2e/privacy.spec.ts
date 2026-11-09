import { expect, seed, test } from "./fixtures";

test("sign-in links to privacy and explains unavailable password recovery", async ({ page }) => {
  await seed(page);
  await page.goto("/signin");
  await expect(page.getByText(/Password recovery and email verification are not available/)).toBeVisible();
  await page.getByRole("link", { name: "Privacy notice", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Privacy notice", exact: true })).toBeVisible();
  await expect(page.getByText(/The data controller is Miguel Cordero Collar/)).toBeVisible();
  await expect(page.getByRole("link", { name: "GitHub issues", exact: true })).toHaveAttribute("href", "https://github.com/miguelcorderocollar/endless-ai-quiz/issues");
  await expect(page.getByText(/Sign-in requires an account/)).toBeVisible();
  await expect(page.getByText(/The mobile app can create accounts but does not yet offer in-app account deletion/)).toBeVisible();
  await expect(page.getByText(/Convex hosts the database/)).toBeVisible();
  await expect(page.getByText(/background batches/)).toBeVisible();
  await expect(page.getByText(/Provider backups and operational logs/)).toBeVisible();
});
