/**
 * Map over items with a bounded number of concurrent workers, preserving input
 * order in the results. The mapper is expected not to reject; a rejection
 * propagates like `Promise.all`.
 */
export async function mapWithConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const total = items.length;
  const results: R[] = new Array<R>(total);
  let cursor = 0;
  const worker = async (): Promise<void> => {
    while (cursor < total) {
      const index = cursor;
      cursor += 1;
      results[index] = await fn(items[index] as T, index);
    }
  };
  const poolSize = Math.max(1, Math.min(limit, total));
  await Promise.all(Array.from({ length: poolSize }, () => worker()));
  return results;
}
