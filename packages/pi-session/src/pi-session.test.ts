import { describe, expect, it } from "vitest";
import { createSessionStore, type SessionRecord, type SessionQuery } from "./index.ts";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";

function freshStore() {
  return createSessionStore(join(tmpdir(), `pi-session-${randomUUID()}.json`));
}

describe("createSessionStore", () => {
  it("creates a session record", async () => {
    const store = freshStore();
    const session = await store.create({
      cwd: "/tmp/workspace",
      provider: "openai",
      model: "gpt-4o",
    });

    expect(session.id).toBeTruthy();
    expect(session.cwd).toBe("/tmp/workspace");
    expect(session.provider).toBe("openai");
    expect(session.model).toBe("gpt-4o");
    expect(session.messageCount).toBe(0);
    expect(session.title).toMatch(/^Session /);
  });

  it("returns undefined for missing session", async () => {
    const store = freshStore();
    const session = await store.get("missing-id");
    expect(session).toBeUndefined();
  });

  it("lists sessions with optional cwd filter", async () => {
    const store = freshStore();
    await store.create({ cwd: "/tmp/workspace-a", provider: "openai", model: "gpt-4o" });
    await store.create({ cwd: "/tmp/workspace-b", provider: "openai", model: "gpt-4o" });

    const all = await store.list();
    expect(all).toHaveLength(2);

    const filtered = await store.list({ cwd: "/tmp/workspace-a" });
    expect(filtered).toHaveLength(1);
    expect(filtered[0]?.cwd).toBe("/tmp/workspace-a");
  });

  it("updates an existing session", async () => {
    const store = freshStore();
    const created = await store.create({ cwd: "/tmp/workspace", provider: "openai", model: "gpt-4o" });
    const updated = await store.update(created.id, { title: "Updated", messageCount: 5 });

    expect(updated?.title).toBe("Updated");
    expect(updated?.messageCount).toBe(5);
    expect(updated?.id).toBe(created.id);
  });

  it("removes a session", async () => {
    const store = freshStore();
    const created = await store.create({ cwd: "/tmp/workspace", provider: "openai", model: "gpt-4o" });
    const removed = await store.remove(created.id);
    expect(removed).toBe(true);

    const session = await store.get(created.id);
    expect(session).toBeUndefined();
  });
});
