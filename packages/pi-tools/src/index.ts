import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

export type ToolPermission = "allow" | "ask" | "deny";
export type SandboxMode = "read-only" | "workspace-write" | "danger-full-access";

export interface ToolPolicy {
  readonly tool: string;
  readonly permission: ToolPermission;
  readonly reason?: string;
}

export interface SandboxPolicy {
  readonly mode: SandboxMode;
  readonly allowedPaths?: readonly string[];
  readonly deniedPaths?: readonly string[];
}

export interface AccessContext {
  readonly cwd: string;
  readonly tool: string;
  readonly args: Readonly<Record<string, unknown>>;
}

export interface ApprovalRequest {
  readonly id: string;
  readonly context: AccessContext;
  readonly policy: ToolPolicy;
  readonly createdAt: Date;
}

export interface ApprovalDecision {
  readonly requestId: string;
  readonly approved: boolean;
  readonly reason?: string;
  readonly decidedAt: Date;
}

export interface ToolAccessControl {
  evaluate(context: AccessContext): ToolPolicy;
  requestApproval(context: AccessContext): Promise<ApprovalRequest>;
  decide(requestId: string, approved: boolean, reason?: string): Promise<ApprovalDecision | undefined>;
  batchDecide(decisions: Array<{ requestId: string; approved: boolean; reason?: string }>): Promise<ApprovalDecision[]>;
  watch(callback: () => void): () => void;
}

export interface SandboxController {
  readonly policy: SandboxPolicy;
  enforce(context: AccessContext): void;
}

export interface AuditEntry {
  readonly id: string;
  readonly tool: string;
  readonly permission: ToolPermission;
  readonly approved: boolean;
  readonly reason?: string;
  readonly createdAt: Date;
}

export interface ToolAuditLogger {
  log(entry: Omit<AuditEntry, "id" | "createdAt">): AuditEntry;
  list(query?: { tool?: string; limit?: number }): AuditEntry[];
}

const DEFAULT_POLICY_PATH = resolve(process.env.PI_CODING_AGENT_DIR ?? join(process.env.HOME ?? "~", ".pi", "agent"), "tools", "policy.json");
const DEFAULT_AUDIT_PATH = resolve(process.env.PI_CODING_AGENT_DIR ?? join(process.env.HOME ?? "~", ".pi", "agent"), "tools", "audit.json");

function ensureDir(path: string): void {
  if (!existsSync(path)) {
    mkdirSync(path, { recursive: true });
  }
}

function readJson(path: string): unknown {
  if (!existsSync(path)) {
    return null;
  }
  try {
    const raw = readFileSync(path, "utf-8");
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function writeJson(path: string, value: unknown): void {
  ensureDir(join(path, ".."));
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}

export function createToolAccessControl(policyPath = DEFAULT_POLICY_PATH): ToolAccessControl {
  const memory = policyPath === ":memory:";
  const policies: ToolPolicy[] = [
    { tool: "read_file", permission: "allow" },
    { tool: "search", permission: "allow" },
    { tool: "execute_command", permission: "ask" },
    { tool: "write_file", permission: "ask" },
    { tool: "delete_file", permission: "deny" },
  ];

  const pendingApprovals = new Map<string, ApprovalRequest>();
  const watchers = new Set<() => void>();

  function loadPolicies(): void {
    if (memory) {
      return;
    }
    const stored = readJson(policyPath);
    if (Array.isArray(stored)) {
      policies.length = 0;
      for (const item of stored) {
        if (isPolicy(item)) {
          policies.push(item);
        }
      }
    }
  }

  function notifyWatchers(): void {
    for (const watcher of watchers) {
      watcher();
    }
  }

  loadPolicies();

  return {
    evaluate(context: AccessContext): ToolPolicy {
      const policy = policies.find((item) => item.tool === context.tool);
      return policy ?? { tool: context.tool, permission: "ask" };
    },

    async requestApproval(context: AccessContext): Promise<ApprovalRequest> {
      const policy = this.evaluate(context);
      if (policy.permission !== "ask") {
        throw new Error(`Tool ${context.tool} does not require approval`);
      }
      const request: ApprovalRequest = {
        id: randomUUID(),
        context,
        policy,
        createdAt: new Date(),
      };
      pendingApprovals.set(request.id, request);
      notifyWatchers();
      return request;
    },

    async decide(requestId: string, approved: boolean, reason?: string): Promise<ApprovalDecision | undefined> {
      const request = pendingApprovals.get(requestId);
      if (!request) {
        return undefined;
      }
      pendingApprovals.delete(requestId);
      const decision: ApprovalDecision = {
        requestId,
        approved,
        reason,
        decidedAt: new Date(),
      };
      return decision;
    },

    async batchDecide(decisions: Array<{ requestId: string; approved: boolean; reason?: string }>): Promise<ApprovalDecision[]> {
      const results: ApprovalDecision[] = [];
      for (const decision of decisions) {
        const result = await this.decide(decision.requestId, decision.approved, decision.reason);
        if (result) {
          results.push(result);
        }
      }
      return results;
    },

    watch(callback: () => void): () => void {
      watchers.add(callback);
      return () => {
        watchers.delete(callback);
      };
    },
  };
}

export function createSandboxController(policy: SandboxPolicy): SandboxController {
  return {
    policy,
    enforce(context: AccessContext): void {
      const deniedPaths = policy.deniedPaths ?? [];
      const argPath = context.args.path;
      const target = resolve(typeof argPath === "string" ? argPath : context.cwd);

      for (const denied of deniedPaths) {
        if (target.startsWith(resolve(denied))) {
          throw new Error(`Access denied by sandbox policy: ${denied}`);
        }
      }

      if (policy.mode === "read-only" && context.tool !== "read_file" && context.tool !== "search") {
        throw new Error(`Tool ${context.tool} is not allowed in read-only sandbox`);
      }
    },
  };
}

export function createToolAuditLogger(auditPath = DEFAULT_AUDIT_PATH): ToolAuditLogger {
  const memory = auditPath === ":memory:";
  let entries: AuditEntry[] = [];

  function load(): void {
    if (memory) {
      return;
    }
    const stored = readJson(auditPath);
    if (Array.isArray(stored)) {
      entries = stored.filter(isAuditEntry).map((entry) => ({
        ...entry,
        createdAt: new Date(entry.createdAt),
      }));
    }
  }

  function save(): void {
    if (memory) {
      return;
    }
    writeJson(auditPath, entries);
  }

  load();

  return {
    log(entry: Omit<AuditEntry, "id" | "createdAt">): AuditEntry {
      const auditEntry: AuditEntry = {
        id: randomUUID(),
        ...entry,
        createdAt: new Date(),
      };
      entries.push(auditEntry);
      save();
      return auditEntry;
    },

    list(query?: { tool?: string; limit?: number }): AuditEntry[] {
      let result = entries;
      if (query?.tool) {
        result = result.filter((entry) => entry.tool === query.tool);
      }
      const limit = query?.limit ?? 50;
      return result.slice(-limit);
    },
  };
}

function isPolicy(value: unknown): value is ToolPolicy {
  if (!isObject(value)) {
    return false;
  }
  const record = value;
  return typeof record.tool === "string" && ["allow", "ask", "deny"].includes(String(record.permission));
}

function isAuditEntry(value: unknown): value is AuditEntry {
  if (!isObject(value)) {
    return false;
  }
  const record = value;
  return (
    typeof record.id === "string" &&
    typeof record.tool === "string" &&
    ["allow", "ask", "deny"].includes(String(record.permission)) &&
    typeof record.approved === "boolean" &&
    record.createdAt !== undefined
  );
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
