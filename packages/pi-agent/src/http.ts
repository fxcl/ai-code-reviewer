import { setTimeout as delay } from "node:timers/promises";

const DEFAULT_MAX_RETRIES = 3;
const DEFAULT_MAX_TOKENS = 4096;
const DEFAULT_TEMPERATURE = 0;
const DEFAULT_TIMEOUT_MS = 120_000;

export {
  DEFAULT_MAX_RETRIES,
  DEFAULT_MAX_TOKENS,
  DEFAULT_TEMPERATURE,
  DEFAULT_TIMEOUT_MS,
};

function asArray<T>(value: unknown): readonly T[] {
  return Array.isArray(value) ? value : [];
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return isObject(value) ? (value as Record<string, unknown>) : null;
}

function isObject(value: unknown): boolean {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function extractUsage(
  usage: unknown,
  inputKey: string,
  outputKey: string
): { inputTokens: number; outputTokens: number } | null {
  const record = asRecord(usage);
  if (!record) return null;
  const inputTokens = typeof record[inputKey] === "number" ? (record[inputKey] as number) : 0;
  const outputTokens = typeof record[outputKey] === "number" ? (record[outputKey] as number) : 0;
  if (!inputTokens && !outputTokens) return null;
  return { inputTokens, outputTokens };
}

export { asArray, asRecord, extractUsage };

export async function postJson<T>(opts: {
  url: string;
  headers?: Record<string, string>;
  body: unknown;
  timeoutMs?: number;
  redact?: readonly string[];
}): Promise<T> {
  const controller = new AbortController();
  const timeout = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const timer = setTimeout(() => controller.abort(), timeout);
  try {
    const response = await fetch(opts.url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(opts.headers ?? {}),
      },
      body: JSON.stringify(opts.body),
      signal: controller.signal,
    });
    if (!response.ok) {
      const text = await response.text();
      throw new Error(`HTTP ${response.status}: ${text}`);
    }
    return (await response.json()) as T;
  } finally {
    clearTimeout(timer);
  }
}

export { isObject };
