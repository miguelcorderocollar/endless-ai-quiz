import { ConvexError } from "convex/values";

export function deletionErrorMessage(error: unknown): string {
  if (error instanceof ConvexError && typeof error.data === "string") return error.data;
  if (error instanceof Error) return error.message;
  return "Could not start deletion. Check your connection and try again.";
}
