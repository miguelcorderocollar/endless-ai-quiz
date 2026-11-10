import { describe, expect, it } from "vitest";

import { LENGTH_CAPS, lengthViolations } from "./schema";

const fits = {
  text: "Which company released GPT-4 in March 2023?",
  options: ["OpenAI", "Google", "Meta", "Anthropic"],
  explanation: "OpenAI released GPT-4 in March 2023 as the successor to GPT-3.5.",
};

describe("lengthViolations", () => {
  it("passes a question inside every cap", () => {
    expect(lengthViolations(fits)).toEqual([]);
  });

  it("allows a field exactly at its cap", () => {
    expect(
      lengthViolations({
        text: "a".repeat(LENGTH_CAPS.text),
        options: ["b".repeat(LENGTH_CAPS.option), "c", "d", "e"],
        explanation: "f".repeat(LENGTH_CAPS.explanation),
      }),
    ).toEqual([]);
  });

  it("reports each field that runs one character over", () => {
    const messages = lengthViolations({
      text: "a".repeat(LENGTH_CAPS.text + 1),
      options: ["b", "c", "d".repeat(LENGTH_CAPS.option + 1), "e"],
      explanation: "f".repeat(LENGTH_CAPS.explanation + 1),
    });
    expect(messages).toEqual([
      `text is ${LENGTH_CAPS.text + 1} characters, cap is ${LENGTH_CAPS.text}`,
      `option C is ${LENGTH_CAPS.option + 1} characters, cap is ${LENGTH_CAPS.option}`,
      `explanation is ${LENGTH_CAPS.explanation + 1} characters, cap is ${LENGTH_CAPS.explanation}`,
    ]);
  });

  it("counts code points, so an emoji is one character", () => {
    // Each 🤖 is two UTF-16 units, so .length would double-count it.
    const text = "🤖".repeat(LENGTH_CAPS.text);
    expect(text.length).toBe(LENGTH_CAPS.text * 2);
    expect(lengthViolations({ ...fits, text })).toEqual([]);
  });
});
