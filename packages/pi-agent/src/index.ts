import type { SpawnOptions } from "node:child_process";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { Readable } from "node:stream";

export { createLLMProvider, type LLMProvider, type LLMUsage, type Message, type ProviderConfig, type StructuredRequest, type StructuredResponse, type ProviderKind, type LLMErrorCode } from './llm-factory';
export { LLMError } from './llm-factory';
export { AnthropicProvider, OpenAIProvider, OllamaProvider } from './providers';
export type Permission = "plan" | "ask" | "auto" | "full";
export type Sandbox = "read-only" | "workspace-write" | "danger-full-access";

export interface PiAgentOptions {
  cwd: string;
  provider: "openai" | "anthropic" | "deepseek" | "ollama" | "openai-compatible";
  model?: string;
  permission?: Permission;
sandbox?: Sandbox;
  apiKey?: string;
  baseURL?: string;
  extraArgs?: string[];
}

export type PiAgentEvent =
  | { type: "text"; text: string }
  | { type: "tool_call"; name: string; arguments: Record<string, unknown> }
  | { type: "tool_result"; id: string; output: string }
  | { type: "error"; message: string }
  | { type: "done" };

export interface PiAgentRuntime {
  send(message: string): AsyncIterable<PiAgentEvent>;
  stop(): Promise<void>;
}

const DEFAULT_TIMEOUT_MS = 45_000;
const MAX_RETRIES = 2;
const RETRY_BACKOFF_MS = 200;
const JSON_RPC_VERSION = "2.0";
const PI_AGENT_DIR = resolve(homedir(), ".pi", "agent");
const SESSIONS_DIR = join(PI_AGENT_DIR, "sessions");
const RUNTIME_LOG_DIR = join(PI_AGENT_DIR, "runtime-logs");

function ensureDir(path: string): void {
  if (!existsSync(path)) {
    mkdirSync(path, { recursive: true });
  }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function toJson(value: unknown): string {
  return JSON.stringify(value);
}

export function normalizeChunk(chunk: unknown): string {
  if (typeof chunk === "string") return chunk;
  if (Buffer.isBuffer(chunk)) return chunk.toString("utf-8");
  if (isObject(chunk) && typeof chunk.value === "string") return chunk.value;
  return "";
}

export function extractMessagePayloads(
  buffer: string
): Array<{ id?: string | number; method?: string; params?: Record<string, unknown>; result?: unknown; error?: { message?: string } }> {
  const messages: Array<{ id?: string | number; method?: string; params?: Record<string, unknown>; result?: unknown; error?: { message?: string } }> = [];
  let index = 0;
  while (index < buffer.length) {
    const start = buffer.indexOf("\n", index);
    if (start === -1) break;
    const raw = buffer.slice(index, start).trim();
    if (!raw) {
      index = start + 1;
      continue;
    }
    try {
      const parsed = JSON.parse(raw);
      messages.push(parsed);
    } catch {
      // ignore non-JSON noise from mixed stdout/stderr
    }
    index = start + 1;
  }
  return messages;
}

export function buildAgentEnv(cwd: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  const projectDir = resolve(cwd);
  const projectName = basename(projectDir) || "workspace";
  const sessionId = `${projectName}-${randomUUID()}`;
  env.PI_CODING_AGENT_DIR = PI_AGENT_DIR;
  env.PI_CODING_AGENT_SESSION_ID = sessionId;
  return env;
}

function basename(path: string): string {
  const lastSeparator = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
  return lastSeparator === -1 ? path : path.slice(lastSeparator + 1);
}

function resolveAgentBinary(): string {
  const localBinary = join(process.cwd(), "node_modules", ".bin", "pi-coding-agent");
  if (existsSync(localBinary)) return localBinary;
  const globalBinary = join(homedir(), ".pi", "agent", "bin", "pi-coding-agent");
  if (existsSync(globalBinary)) return globalBinary;
  return "pi-coding-agent";
}

export function buildAgentArgs(options: PiAgentOptions): string[] {
  const args: string[] = [
    "--mode",
    "rpc",
    "--provider",
    options.provider,
    "--cwd",
    resolve(options.cwd),
  ];
  if (options.model) args.push("--model", options.model);
  if (options.permission) args.push("--permission", options.permission);
  if (options.sandbox) args.push("--sandbox", options.sandbox);
  if (options.apiKey) args.push("--api-key", options.apiKey);
  if (options.baseURL) args.push("--base-url", options.baseURL);
  if (options.extraArgs?.length) args.push(...options.extraArgs);
  return args;
}

export function buildRpcRequest(id: string | number, method: string, params?: unknown): string {
  const payload: Record<string, unknown> = {
    jsonrpc: JSON_RPC_VERSION,
    id,
    method,
  };
  if (params !== undefined) {
    payload.params = params;
  }
  return `${toJson(payload)}\n`;
}

export class RpcStreamReader {
  #buffer = "";
  #listeners = new Map<string, Set<(value: PiAgentEvent) => void>>();
  #resolves = new Map<
    string | number,
    { resolve: (value: unknown) => void; reject: (reason: Error) => void; timer: ReturnType<typeof setTimeout> }
  >();
  #nextId = 1;
  #closed = false;
  #sink: (payload: string) => void;

  constructor(stream: Readable, sink?: (payload: string) => void) {
    this.#sink = sink ?? ((payload: string) => { stream.push(payload); });
    this.#streamOn(stream);
  }

  #streamOn(stream: Readable): void {
    stream.on("data", (chunk) => this.#handleData(chunk));
    stream.on("error", (error) => this.#handleError(error));
    stream.on("end", () => this.#handleEnd());
  }

  #handleData(chunk: unknown): void {
    const text = normalizeChunk(chunk);
    if (!text) return;
    this.#buffer += text;
    const messages = extractMessagePayloads(this.#buffer);
    if (!messages.length) return;
    const lastMessage = messages[messages.length - 1];
    const marker = `${toJson(lastMessage)}\n`;
    const markerIndex = this.#buffer.lastIndexOf(marker);
    if (markerIndex === -1) {
      this.#buffer = "";
    } else {
      this.#buffer = this.#buffer.slice(markerIndex + marker.length);
    }
    for (const message of messages) {
      const id = typeof message.id === "number" || typeof message.id === "string" ? message.id : undefined;
      if (typeof message.method === "string") {
        this.#handleNotification(message);
        continue;
      }
      if (id !== undefined) this.#resolveRequest(id, message);
    }
  }

  #handleError(error: Error): void {
    if (this.#closed) return;
    this.#rejectAll(error);
  }

  #handleEnd(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#rejectAll(new Error("pi-coding-agent RPC stream ended unexpectedly"));
  }

  #handleNotification(message: { method?: string; params?: Record<string, unknown> }): void {
    const listeners = this.#listeners.get(message.method ?? "");
    if (!listeners?.size) return;
    const event = this.#normalizeEvent(message);
    for (const listener of listeners) listener(event);
  }

  #resolveRequest(
    id: string | number,
    message: { result?: unknown; error?: { message?: string } }
  ): void {
    const pending = this.#resolves.get(id);
    if (!pending) return;
    clearTimeout(pending.timer);
    this.#resolves.delete(id);
    if (isObject(message.error)) {
      pending.reject(new Error(message.error.message ?? "pi-coding-agent RPC request failed"));
      return;
    }
    pending.resolve(message.result ?? null);
  }

  #rejectAll(reason: Error): void {
    for (const [, pending] of this.#resolves) {
      clearTimeout(pending.timer);
      pending.reject(reason);
    }
    this.#resolves.clear();
  }

  async request(method: string, params?: unknown, timeoutMs = DEFAULT_TIMEOUT_MS): Promise<unknown> {
    if (this.#closed) throw new Error("pi-coding-agent RPC stream is closed");
    let attempt = 0;
    while (true) {
      const id = this.#nextId++;
      const payload = buildRpcRequest(id, method, params);
      const promise = new Promise<unknown>((resolve, reject) => {
        const timer = setTimeout(() => {
          this.#resolves.delete(id);
          reject(new Error(`pi-coding-agent RPC timeout after ${timeoutMs}ms`));
        }, timeoutMs);
        this.#resolves.set(id, { resolve, reject, timer });
      });
      this.#sink(payload);
      try {
        return await promise;
      } catch (error) {
        const message = error instanceof Error ? error.message : "Unknown error";
        const retryable = message.includes("timeout") || message.includes("ECONNRESET") || message.includes("EPIPE");
        if (!retryable || ++attempt > MAX_RETRIES) throw error;
        await delay(RETRY_BACKOFF_MS * attempt);
      }
    }
  }

  onNotification(method: string, listener: (value: PiAgentEvent) => void): () => void {
    if (!this.#listeners.has(method)) this.#listeners.set(method, new Set());
    this.#listeners.get(method)!.add(listener);
    return () => {
      this.#listeners.get(method)?.delete(listener);
      if (this.#listeners.get(method)?.size === 0) this.#listeners.delete(method);
    };
  }

  #normalizeEvent(message: { method?: string; params?: Record<string, unknown> }): PiAgentEvent {
    const params = message.params ?? {};
    switch (message.method) {
      case "agent/event/text":
        return { type: "text", text: typeof params.text === "string" ? params.text : "" };
      case "agent/event/tool_call":
        return {
          type: "tool_call",
          name: typeof params.name === "string" ? params.name : "unknown",
          arguments: isObject(params.arguments) ? (params.arguments as Record<string, unknown>) : {},
        };
      case "agent/event/tool_result":
        return {
          type: "tool_result",
          id: typeof params.id === "string" ? params.id : "",
          output: typeof params.output === "string" ? params.output : "",
        };
      case "agent/event/error":
        return {
          type: "error",
          message: typeof params.message === "string" ? params.message : "Unknown pi-coding-agent error",
        };
      default:
        return { type: "text", text: typeof params.text === "string" ? params.text : toJson(params) };
    }
  }

  [Symbol.asyncIterator](): AsyncIterableIterator<PiAgentEvent> {
    const self = this;
    const iterator: AsyncIterableIterator<PiAgentEvent> = {
      next: async () => {
        const value = await self.request("agent/next", undefined, 0);
        if (value === null) return { value: undefined as unknown as PiAgentEvent, done: true };
        const event = self.#normalizeEvent({ params: value as Record<string, unknown> });
        return { value: event, done: false };
      },
      return: async () => {
        self.close();
        return { value: undefined as unknown as PiAgentEvent, done: true };
      },
      [Symbol.asyncIterator]: () => iterator,
    };
    return iterator;
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#rejectAll(new Error("pi-coding-agent RPC stream closed"));
  }
}

export class ReadableQueue<T> {
  #resolves: Array<{ resolve: (value: T) => void; reject: (reason: Error) => void }> = [];
  #closed = false;

  next(value: T): void {
    if (this.#closed) return;
    const next = this.#resolves.shift();
    if (next) next.resolve(value);
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    for (const next of this.#resolves) next.reject(new Error("closed"));
    this.#resolves = [];
  }

  advance(signal: AbortSignal): Promise<T> {
    if (this.#closed) return Promise.reject(new Error("closed"));
    return new Promise((resolve, reject) => {
      const entry = { resolve, reject };
      this.#resolves.push(entry);
      signal.addEventListener("abort", () => {
        this.#resolves = this.#resolves.filter((item) => item !== entry);
        reject(new Error("aborted"));
      });
    });
  }

  [Symbol.asyncIterator](): AsyncIterableIterator<T> {
    const self = this;
    const iterator: AsyncIterableIterator<T> = {
      next: async () => {
        if (self.#closed) return { value: undefined as unknown as T, done: true };
        try {
          const value = await self.advance(new AbortController().signal);
          return { value, done: false };
        } catch {
          return { value: undefined as unknown as T, done: true };
        }
      },
      return: async () => {
        self.close();
        return { value: undefined as unknown as T, done: true };
      },
      [Symbol.asyncIterator]: () => iterator,
    };
    return iterator;
  }
}

export class PiAgentClient implements PiAgentRuntime {
  #options: PiAgentOptions;
  #process: ReturnType<typeof spawn> | null = null;
  #reader: RpcStreamReader | null = null;
  #cleanup: (() => Promise<void>) | null = null;
  #started = false;

  constructor(options: PiAgentOptions) {
    this.#options = options;
  }

  static async create(options: PiAgentOptions): Promise<PiAgentClient> {
    const instance = new PiAgentClient(options);
    await instance.#start();
    return instance;
  }

  send(message: string): AsyncIterable<PiAgentEvent> {
    return this.#createAsyncIterator(message);
  }

  async stop(): Promise<void> {
    await this.#cleanup?.();
    this.#cleanup = null;
    this.#reader = null;
    this.#process = null;
    this.#started = false;
  }

  async #start(): Promise<void> {
    if (this.#started) return;
    const binary = resolveAgentBinary();
    const args = buildAgentArgs(this.#options);
    const env = buildAgentEnv(this.#options.cwd);
    const cwd = resolve(this.#options.cwd);
    ensureDir(PI_AGENT_DIR);
    ensureDir(SESSIONS_DIR);
    ensureDir(RUNTIME_LOG_DIR);

    const child = spawn(binary, args, {
      cwd,
      env,
      stdio: ["pipe", "pipe", "pipe"],
    } as SpawnOptions);

    this.#process = child;
    this.#reader = new RpcStreamReader(child.stdout!);

    const initPromise = this.#reader.request("agent/initialize", {
      cwd,
      sessionId: env.PI_CODING_AGENT_SESSION_ID,
    });

    this.#cleanup = async () => {
      this.#reader?.close();
      this.#reader = null;
      if (this.#process) {
        this.#process.kill("SIGTERM");
        this.#process = null;
      }
    };

    try {
      await initPromise;
      this.#started = true;
    } catch (error) {
      await this.#cleanup?.();
      throw new Error(
        `Failed to start pi-coding-agent: ${error instanceof Error ? error.message : String(error)}. Install it first with: npm install -g pi-coding-agent`
      );
    }
  }

  async *#createAsyncIterator(message: string): AsyncIterable<PiAgentEvent> {
    if (!this.#reader) throw new Error("pi-coding-agent runtime is not started");
    const stream = this.#reader;
    const notifications = stream.onNotification("agent/event/text", (event) => event);
    try {
      yield* stream[Symbol.asyncIterator]();
    } finally {
      notifications();
    }
  }
}

export function createPiAgent(options: PiAgentOptions): PiAgentRuntime {
  return new PiAgentClient(options);
}
