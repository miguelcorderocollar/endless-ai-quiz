import { expect, it } from "vitest";
import { ConvexError } from "convex/values";
import { SIGN_IN_REQUIRED, rateLimitData, rateLimitMessage } from "./errors";

it("pins the installed-client auth retry protocol", () => {
  expect(SIGN_IN_REQUIRED).toBe("Sign in required.");
  expect(new ConvexError(SIGN_IN_REQUIRED).data).toBe("Sign in required.");
});
it("maps structured quota errors to friendly copy and a finite retry delay", () => {
  const error = new ConvexError({ kind: "RateLimited", retryAfter: 1500 });
  expect(rateLimitData(error)).toEqual({ retryAfter: 1500 });
  expect(rateLimitMessage(error)).toBe("Too many requests. Please wait a moment and try again.");
  expect(rateLimitData(new ConvexError({ kind: "RateLimited", retryAfter: NaN }))).toEqual({ retryAfter: 1000 });
  expect(rateLimitMessage(new Error("offline"))).toBeNull();
});
