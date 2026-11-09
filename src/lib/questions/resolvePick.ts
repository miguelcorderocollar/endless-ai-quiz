import type { Question } from "./schema";

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
    try {
      const disconnected = new Promise<null>((resolve) => {
        unsubscribe = observeOffline?.(() => resolve(null)) ?? unsubscribe;
      });
      const result = await Promise.race([
        reveal({ questionId: question.id, picked }), disconnected,
      ]);
      if (result) {
        return { ...question, answer: result.answer, explanation: result.explanation, source: result.source };
      }
    } finally {
      unsubscribe();
    }
  }
  const local = (await fallback()).find((q) => q.id === question.id);
  // Never grade a stale online question against a different offline revision.
  if (!local || local.text !== question.text ||
      local.options.some((option, i) => option !== question.options[i])) {
    throw new Error("Question unavailable offline");
  }
  return local;
}
