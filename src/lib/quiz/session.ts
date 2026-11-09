import type { Question } from "../questions/schema";

type Phase = "question" | "revealed";

export type QuizSession = {
  filterKey: string;
  currentId: string;
  seenIds: string[];
  phase: Phase;
  picked: string | null;
  exhausted: boolean;
  revealedQuestion?: Question;
};

export const quizSession = { current: null as QuizSession | null };

export function clearQuizSession(): void {
  quizSession.current = null;
}
