import { HOUR, MINUTE, RateLimiter } from "@convex-dev/rate-limiter";
import type { ComponentApi } from "@convex-dev/rate-limiter/_generated/component.js";
import { componentsGeneric } from "convex/server";

// Typed component reference until deployment codegen refreshes _generated/api.
// No deployment is needed to compile or exercise this component in convex-test.
const rateLimiterComponent = componentsGeneric().rateLimiter as unknown as ComponentApi;
export const rateLimiter = new RateLimiter(rateLimiterComponent, {
  signUpEmail: { kind: "token bucket", rate: 1, period: HOUR, capacity: 1 },
  signUpGlobal: { kind: "token bucket", rate: 100, period: HOUR, capacity: 100 },
  answer: { kind: "token bucket", rate: 60, period: MINUTE, capacity: 60 },
  displayName: { kind: "token bucket", rate: 5, period: MINUTE, capacity: 5 },
});
