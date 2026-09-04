import { describe, expect, it, vi } from "vitest";
import { createSandboxController, createToolAccessControl, createToolAuditLogger, type AccessContext, type SandboxPolicy } from "./index";

describe("createToolAccessControl", () => {
  it("returns default allow policy for known tool", () => {
    const accessControl = createToolAccessControl(":memory:");
    const context: AccessContext = { cwd: "/tmp/workspace", tool: "read_file", args: {} };
    const policy = accessControl.evaluate(context);
    expect(policy).toEqual({ tool: "read_file", permission: "allow" });
  });

  it("returns ask policy for unknown tool", () => {
    const accessControl = createToolAccessControl(":memory:");
    const context: AccessContext = { cwd: "/tmp/workspace", tool: "unknown_tool", args: {} };
    const policy = accessControl.evaluate(context);
    expect(policy).toEqual({ tool: "unknown_tool", permission: "ask" });
  });

  it("creates approval request for ask policy", async () => {
    const accessControl = createToolAccessControl(":memory:");
    const context: AccessContext = { cwd: "/tmp/workspace", tool: "write_file", args: {} };
    const request = await accessControl.requestApproval(context);
    expect(request.id).toBeTruthy();
    expect(request.policy.tool).toBe("write_file");
    expect(request.policy.permission).toBe("ask");
  });

  it("throws for non-ask policy", async () => {
    const accessControl = createToolAccessControl(":memory:");
    const context: AccessContext = { cwd: "/tmp/workspace", tool: "read_file", args: {} };
    await expect(accessControl.requestApproval(context)).rejects.toThrow("does not require approval");
  });

  it("decides approval request", async () => {
    const accessControl = createToolAccessControl(":memory:");
    const context: AccessContext = { cwd: "/tmp/workspace", tool: "write_file", args: {} };
    const request = await accessControl.requestApproval(context);
    const decision = await accessControl.decide(request.id, true, "approved");
    expect(decision?.approved).toBe(true);
    expect(decision?.requestId).toBe(request.id);
  });

  it("batch decides multiple approval requests", async () => {
    const accessControl = createToolAccessControl(":memory:");
    const context: AccessContext = { cwd: "/tmp/workspace", tool: "write_file", args: {} };
    const first = await accessControl.requestApproval(context);
    const second = await accessControl.requestApproval(context);
    const decisions = await accessControl.batchDecide([
      { requestId: first.id, approved: true, reason: "approved" },
      { requestId: second.id, approved: false, reason: "blocked" },
    ]);
    expect(decisions).toHaveLength(2);
    expect(decisions[0]?.approved).toBe(true);
    expect(decisions[1]?.approved).toBe(false);
  });

  it("notifies watchers on policy reload", async () => {
    const accessControl = createToolAccessControl(":memory:");
    const watcher = vi.fn();
    const unwatch = accessControl.watch(watcher);
    await accessControl.requestApproval({ cwd: "/tmp", tool: "write_file", args: {} });
    expect(watcher).toHaveBeenCalledTimes(1);
    unwatch();
  });
});

describe("createSandboxController", () => {
  const policy: SandboxPolicy = {
    mode: "read-only",
    deniedPaths: ["/etc", "/root"],
  };

  it("allows read_file in read-only mode", () => {
    const controller = createSandboxController(policy);
    const context: AccessContext = { cwd: "/tmp/workspace", tool: "read_file", args: { path: "/tmp/workspace/file.ts" } };
    expect(() => controller.enforce(context)).not.toThrow();
  });

  it("denies write_file in read-only mode", () => {
    const controller = createSandboxController(policy);
    const context: AccessContext = { cwd: "/tmp/workspace", tool: "write_file", args: { path: "/tmp/workspace/file.ts" } };
    expect(() => controller.enforce(context)).toThrow("not allowed in read-only sandbox");
  });

  it("denies access to denied paths", () => {
    const controller = createSandboxController(policy);
    const context: AccessContext = { cwd: "/tmp/workspace", tool: "read_file", args: { path: "/etc/passwd" } };
    expect(() => controller.enforce(context)).toThrow("Access denied by sandbox policy");
  });
});

describe("createToolAuditLogger", () => {
  it("appends and lists audit entries", async () => {
    const logger = createToolAuditLogger(":memory:");
    const first = logger.log({ tool: "read_file", permission: "allow", approved: true, reason: "ok" });
    const second = logger.log({ tool: "write_file", permission: "ask", approved: false, reason: "blocked" });

    expect(first.id).toBeTruthy();
    expect(first.createdAt).toBeInstanceOf(Date);
    const all = logger.list();
    expect(all).toHaveLength(2);
    expect(all[1]?.id).toBe(second.id);
  });

  it("filters entries by tool", async () => {
    const logger = createToolAuditLogger(":memory:");
    logger.log({ tool: "read_file", permission: "allow", approved: true });
    logger.log({ tool: "write_file", permission: "ask", approved: false });

    const filtered = logger.list({ tool: "write_file" });
    expect(filtered).toHaveLength(1);
    expect(filtered[0]?.tool).toBe("write_file");
  });

  it("respects limit", async () => {
    const logger = createToolAuditLogger(":memory:");
    for (let index = 0; index < 5; index++) {
      logger.log({ tool: "read_file", permission: "allow", approved: true });
    }
    const limited = logger.list({ limit: 2 });
    expect(limited).toHaveLength(2);
  });
});
