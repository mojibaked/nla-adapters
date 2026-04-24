export const mapWithConcurrency = async <T, U>(
  items: ReadonlyArray<T>,
  concurrency: number,
  task: (item: T, index: number) => Promise<U>
): Promise<U[]> => {
  if (!Number.isInteger(concurrency) || concurrency < 1) {
    throw new Error(`concurrency must be a positive integer, got ${concurrency}`);
  }

  const results: U[] = new Array(items.length);
  let next = 0;

  const workerCount = Math.min(concurrency, items.length);
  const workers = Array.from({ length: workerCount }, async () => {
    while (true) {
      const i = next++;
      if (i >= items.length) return;
      const item = items[i] as T;
      results[i] = await task(item, i);
    }
  });

  await Promise.all(workers);
  return results;
};
