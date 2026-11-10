/** Runs `fn` over `items` with at most `limit` in flight, keeping the result order. Used to turn sequential per-row database round trips into a
 *  bounded parallel batch (the Mongo pool is 10 per instance, so the limit stays below it). A rejection of any call rejects the whole call. */
export async function mapLimit<T, R>(items: readonly T[], limit: number, fn: (item: T, index: number) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  const worker = async () => {
    for (;;) {
      const i = next++;
      if (i >= items.length) return;
      out[i] = await fn(items[i]!, i);
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, worker));
  return out;
}
