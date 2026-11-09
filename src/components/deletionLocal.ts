/** #63 deletion-only cleanup. Switch to #62's shared helper when it lands. */
export function clearDeletedAccountStorage(storage: Pick<Storage, "length" | "key" | "removeItem">) {
  for (let i = storage.length - 1; i >= 0; i--) {
    const key = storage.key(i);
    if (key?.startsWith("endless-ai:")) storage.removeItem(key);
  }
}
