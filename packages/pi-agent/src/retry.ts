export async function withRetry<T>(fn: () => Promise<T>, opts: { maxRetries?: number; sleep?: (ms: number) => Promise<void> } = {}): Promise<T> {
  const maxRetries = opts.maxRetries ?? 3;
  const sleep = opts.sleep ?? ((ms: number) => new Promise((resolve) => setTimeout(resolve, ms)));
  let attempt = 0;
  while (true) {
    try {
      return await fn();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const retryable = /timeout|ECONNRESET|EPIPE|rate.limit|429|5\d\d/.test(message);
      if (!retryable || ++attempt > maxRetries) throw error;
      const retryAfterMs = (error as { retryAfterMs?: number }).retryAfterMs;
      await sleep(retryAfterMs ?? 200 * attempt);
    }
  }
}
