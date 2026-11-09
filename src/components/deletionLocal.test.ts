import { expect, it } from "vitest";
import { clearDeletedAccountStorage } from "./deletionLocal";

it("clears every app key, including unknown future keys, without clearing other storage", () => {
  const values = new Map([
    ["endless-ai:progress:v1", "private"],
    ["other-app", "keep"],
    ["endless-ai:outbox", "private"],
    ["endless-ai:profile", "private"],
    ["endless-ai:future-cache", "private"],
  ]);
  clearDeletedAccountStorage({
    get length() { return values.size; },
    key: i => [...values.keys()][i] ?? null,
    removeItem: key => { values.delete(key); },
  });
  expect([...values]).toEqual([["other-app", "keep"]]);
});
