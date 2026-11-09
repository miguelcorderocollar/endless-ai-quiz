import { ConvexError } from "convex/values";
import { expect, it } from "vitest";
import { deletionErrorMessage } from "./deletionError";

it("shows the specific server re-authentication error without transport details", () => {
  const message = "Sign out and sign in again, then delete within five minutes.";
  expect(deletionErrorMessage(new ConvexError(message))).toBe(message);
  expect(deletionErrorMessage(new Error("Connection lost"))).toBe("Connection lost");
  expect(deletionErrorMessage(null)).toContain("Check your connection");
});
