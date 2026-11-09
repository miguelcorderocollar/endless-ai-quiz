/** Wire protocol: installed clients rely on this exact retryable message. */
export const SIGN_IN_REQUIRED = "Sign in required.";

export function rateLimitData(error: unknown): { retryAfter: number } | null {
  if (typeof error !== "object" || error === null || !("data" in error)) return null;
  const data = error.data;
  if (typeof data !== "object" || data === null || !("kind" in data) || data.kind !== "RateLimited") return null;
  const delay = "retryAfter" in data ? data.retryAfter : undefined;
  return { retryAfter: typeof delay === "number" && Number.isFinite(delay) ? Math.max(1, delay) : 1000 };
}

export function rateLimitMessage(error: unknown): string | null {
  return rateLimitData(error) ? "Too many requests. Please wait a moment and try again." : null;
}
