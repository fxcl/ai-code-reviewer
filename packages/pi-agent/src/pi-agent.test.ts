import { describe, expect, it } from "vitest";
import { Readable } from "node:stream";

const {
  extractMessagePayloads,
  normalizeChunk,
  buildAgentArgs,
  buildAgentEnv,
  buildRpcRequest,
  RpcStreamReader,
  ReadableQueue,
} = await import("./index.js");

describe("extractMessagePayloads", () => {
  it("parses newline-delimited JSON messages", () => {
    const buffer = `{"jsonrpc":"2.0","id":1}\n{"method":"agent/event/text"}\n`;
    const messages = extractMessagePayloads(buffer);
    expect(messages).toHaveLength(2);
    expect(messages[0]?.id).toBe(1);
    expect(messages[1]?.method).toBe("agent/event/text");
  });

  it("ignores incomplete trailing message", () => {
    const buffer = `{"jsonrpc":"2.0","id":1}\n{"method`;
    const messages = extractMessagePayloads(buffer);
    expect(messages).toHaveLength(1);
  });

  it("ignores non-JSON noise", () => {
    const buffer = `noise\n{"method":"agent/event/text"}\n`;
    const messages = extractMessagePayloads(buffer);
    expect(messages).toHaveLength(1);
    expect(messages[0]?.method).toBe("agent/event/text");
  });
});

describe("normalizeChunk", () => {
  it("passes through strings", () => {
    expect(normalizeChunk("hello")).toBe("hello");
  });

  it("converts buffers to string", () => {
    expect(normalizeChunk(Buffer.from("hello"))).toBe("hello");
  });

  it("returns empty string for unsupported objects", () => {
    expect(normalizeChunk({ unknown: true })).toBe("");
  });
});

describe("buildAgentArgs", () => {
  it("builds base args with provider and cwd", () => {
    const args = buildAgentArgs({ cwd: "/tmp", provider: "openai" });
    expect(args).toEqual(["--mode", "rpc", "--provider", "openai", "--cwd", "/tmp"]);
  });

  it("appends optional args when provided", () => {
    const args = buildAgentArgs({
      cwd: "/tmp",
      provider: "openai",
      model: "gpt-4o",
      permission: "full",
      sandbox: "workspace-write",
      apiKey: "key",
      baseURL: "https://example.com",
      extraArgs: ["--debug"],
    });
    expect(args).toEqual([
      "--mode",
      "rpc",
      "--provider",
      "openai",
      "--cwd",
      "/tmp",
      "--model",
      "gpt-4o",
      "--permission",
      "full",
      "--sandbox",
      "workspace-write",
      "--api-key",
      "key",
      "--base-url",
      "https://example.com",
      "--debug",
    ]);
  });
});

describe("buildAgentEnv", () => {
  it("injects pi agent dir and session id", () => {
    const env = buildAgentEnv("/tmp/workspace");
    expect(env.PI_CODING_AGENT_DIR).toBeTruthy();
    expect(env.PI_CODING_AGENT_SESSION_ID).toMatch(/^workspace-/);
  });
});

describe("buildRpcRequest", () => {
  it("wraps params into JSON-RPC payload", () => {
    const payload = buildRpcRequest(1, "agent/send", { text: "hello" });
    const parsed = JSON.parse(payload.trim());
    expect(parsed).toEqual({
      jsonrpc: "2.0",
      id: 1,
      method: "agent/send",
      params: { text: "hello" },
    });
  });
});

describe("RpcStreamReader", () => {
  it("emits notification events", async () => {
    const stream = new Readable({ read() {} });
    const reader = new RpcStreamReader(stream);
    const events: unknown[] = [];
    reader.onNotification("agent/event/text", (event) => events.push(event));
    stream.push(JSON.stringify({ method: "agent/event/text", params: { text: "hi" } }) + "\n");
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(events).toHaveLength(1);
    expect(events[0]).toEqual({ type: "text", text: "hi" });
    reader.close();
    stream.destroy();
  });

  it("resolves requests by id", async () => {
    const stream = new Readable({ read() {} });
    const writes: string[] = [];
    const reader = new RpcStreamReader(stream, (payload) => {
      writes.push(payload);
    });
    const requestPromise = reader.request("agent/initialize");
    stream.push(JSON.stringify({ id: 1, result: { ok: true } }) + "\n");
    const result = await requestPromise;
    expect(result).toEqual({ ok: true });
    expect(writes).toHaveLength(1);
    expect(JSON.parse(writes[0]!)).toEqual({ jsonrpc: "2.0", id: 1, method: "agent/initialize" });
    reader.close();
    stream.destroy();
  });

  it("rejects pending requests on stream error", async () => {
    const stream = new Readable({ read() {} });
    const reader = new RpcStreamReader(stream, () => {});
    const requestPromise = reader.request("agent/initialize");
    stream.emit("error", new Error("boom"));
    await expect(requestPromise).rejects.toThrow("boom");
    reader.close();
    stream.destroy();
  });

  it("retries on retryable timeout and succeeds", async () => {
    const stream = new Readable({ read() {} });
    const writes: string[] = [];
    const reader = new RpcStreamReader(stream, (payload) => {
      writes.push(payload);
    });
    const requestPromise = reader.request("agent/initialize");
    await new Promise((resolve) => setTimeout(resolve, 0));
    stream.push(JSON.stringify({ id: 1, error: { message: "timeout after 1000ms" } }) + "\n");
    await new Promise((resolve) => setTimeout(resolve, 300));
    stream.push(JSON.stringify({ id: 2, result: { ok: true } }) + "\n");
    const result = await requestPromise;
    expect(result).toEqual({ ok: true });
    expect(writes).toHaveLength(2);
    reader.close();
    stream.destroy();
  });

  it("does not retry non-retryable errors", async () => {
    const stream = new Readable({ read() {} });
    const writes: string[] = [];
    const reader = new RpcStreamReader(stream, (payload) => {
      writes.push(payload);
    });
    const requestPromise = reader.request("agent/initialize");
    await new Promise((resolve) => setTimeout(resolve, 0));
    stream.push(JSON.stringify({ id: 1, error: { message: "invalid request" } }) + "\n");
    await expect(requestPromise).rejects.toThrow("invalid request");
    expect(writes).toHaveLength(1);
    reader.close();
    stream.destroy();
  });

  it("rejects after exceeding max retries", async () => {
    const stream = new Readable({ read() {} });
    const writes: string[] = [];
    const reader = new RpcStreamReader(stream, (payload) => {
      writes.push(payload);
    });
    const requestPromise = reader.request("agent/initialize");
    await new Promise((resolve) => setTimeout(resolve, 0));
    stream.push(JSON.stringify({ id: 1, error: { message: "timeout after 1000ms" } }) + "\n");
    await new Promise((resolve) => setTimeout(resolve, 300));
    stream.push(JSON.stringify({ id: 2, error: { message: "timeout after 1000ms" } }) + "\n");
    await new Promise((resolve) => setTimeout(resolve, 500));
    stream.push(JSON.stringify({ id: 3, error: { message: "timeout after 1000ms" } }) + "\n");
    await expect(requestPromise).rejects.toThrow("timeout after 1000ms");
    expect(writes).toHaveLength(3);
    reader.close();
    stream.destroy();
  });

  it("rejects when stream is closed", async () => {
    const stream = new Readable({ read() {} });
    const reader = new RpcStreamReader(stream, () => {});
    reader.close();
    await expect(reader.request("agent/initialize")).rejects.toThrow("pi-coding-agent RPC stream is closed");
    stream.destroy();
  });
});

describe("ReadableQueue", () => {
  it("queues and dequeues values", async () => {
    const queue = new ReadableQueue<number>();
    const advancePromise = queue.advance(new AbortController().signal);
    queue.next(1);
    expect(await advancePromise).toBe(1);
  });

  it("rejects when closed", async () => {
    const queue = new ReadableQueue<number>();
    queue.close();
    await expect(queue.advance(new AbortController().signal)).rejects.toThrow("closed");
  });

  it("rejects when aborted", async () => {
    const controller = new AbortController();
    const queue = new ReadableQueue<number>();
    const advancePromise = queue.advance(controller.signal);
    controller.abort();
    await expect(advancePromise).rejects.toThrow("aborted");
  });
});
