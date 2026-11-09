import type { Question } from "./schema";

export const REVEAL_TIMEOUT_MS = 8_000;

type Reveal = Pick<Question, "answer" | "explanation" | "source"> & { correct: boolean };

/** Resolve only after a pick. Offline and legacy questions remain casual practice. */
export async function resolvePick(
  question: Question,
  picked: string,
  online: boolean,
  reveal: (args: { questionId: string; picked: string }) => Promise<Reveal>,
  fallback: () => Promise<Question[]>,
  observeOffline?: (onOffline: () => void) => () => void,
): Promise<Question> {
  if (!question.options.includes(picked)) throw new Error("Invalid option");
  if (question.answer) return question;
  if (online) {
    let unsubscribe = () => {};
    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
      const disconnected = new Promise<null>((resolve) => {
        unsubscribe = observeOffline?.(() => resolve(null)) ?? unsubscribe;
      });
      const result = await Promise.race([
        reveal({ questionId: question.id, picked }), disconnected,
        new Promise<never>((_, reject) => {
          timeout = setTimeout(() => reject(new Error("Answer check timed out")), REVEAL_TIMEOUT_MS);
        }),
      ]);
      if (result) {
        return { ...question, answer: result.answer, explanation: result.explanation, source: result.source };
      }
    } finally {
      clearTimeout(timeout);
      unsubscribe();
    }
  }
  const local = (await fallback()).find((q) => q.id === question.id);
  // Text and options must match. The bundled answer itself may still be stale.
  if (!local || local.text !== question.text ||
      local.options.some((option, i) => option !== question.options[i])) {
    throw new Error("Question unavailable offline");
  }
  return local;
}
