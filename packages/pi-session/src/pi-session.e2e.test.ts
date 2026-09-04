import { describe, it, expect, beforeEach } from "vitest";
import { createSessionStore, type SessionMessage } from "./index";

describe("pi-session e2e", () => {
  let store: ReturnType<typeof createSessionStore>;

  beforeEach(() => {
    store = createSessionStore("/tmp/pi-session-e2e-test/index.json");
  });

  it("creates a session and appends message history", async () => {
    const session = await store.create({ cwd: "/tmp", provider: "openai", model: "gpt-4o" });
    const first = await store.addMessage(session.id, {
      id: "m1",
      role: "user",
      content: "Hello",
      createdAt: new Date(),
    });
    const second = await store.addMessage(session.id, {
      id: "m2",
      role: "assistant",
      content: "Hi!",
      createdAt: new Date(),
    });

    expect(first?.messageCount).toBe(1);
    expect(first?.messages).toHaveLength(1);
    expect(second?.messageCount).toBe(2);
    expect(second?.messages).toHaveLength(2);
    expect(second?.messages[1].content).toBe("Hi!");
  });

  it("resumes session from last message id", async () => {
    const session = await store.create({ cwd: "/tmp", provider: "openai", model: "gpt-4o" });
    await store.addMessage(session.id, { id: "m1", role: "user", content: "A", createdAt: new Date() });
    await store.addMessage(session.id, { id: "m2", role: "assistant", content: "B", createdAt: new Date() });
    await store.addMessage(session.id, { id: "m3", role: "user", content: "C", createdAt: new Date() });

    const resumed = await store.getMessages(session.id, { lastMessageId: "m2", limit: 10 });
    expect(resumed).toHaveLength(1);
    expect(resumed[0].id).toBe("m3");
  });
});
