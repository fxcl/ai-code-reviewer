import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

export interface SessionRecord {
  readonly id: string;
  readonly cwd: string;
  readonly title: string;
  readonly createdAt: Date;
  readonly updatedAt: Date;
  readonly messageCount: number;
  readonly provider: string;
  readonly model: string;
}

export interface SessionCreateInput {
  readonly cwd: string;
  readonly title?: string;
  readonly provider: string;
  readonly model: string;
}

export interface SessionMessage {
  readonly id: string;
  readonly role: 'user' | 'assistant' | 'system';
  readonly content: string;
  readonly createdAt: Date;
}

export interface SessionWithMessages extends SessionRecord {
  readonly messages: SessionMessage[];
}

export interface SessionUpdateInput {
  readonly title?: string;
  readonly messageCount?: number;
  readonly updatedAt?: Date;
}

export interface SessionResumeOptions {
  readonly lastMessageId?: string;
  readonly limit?: number;
}

export interface SessionQuery {
  readonly cwd?: string;
  readonly limit?: number;
  readonly offset?: number;
}

export interface SessionStore {
  create(input: SessionCreateInput): Promise<SessionRecord>;
  get(id: string): Promise<SessionRecord | undefined>;
  list(query?: SessionQuery): Promise<SessionRecord[]>;
  update(id: string, input: SessionUpdateInput): Promise<SessionRecord | undefined>;
  remove(id: string): Promise<boolean>;
  addMessage(sessionId: string, message: SessionMessage): Promise<SessionWithMessages | undefined>;
  getMessages(sessionId: string, options?: SessionResumeOptions): Promise<SessionMessage[]>;
}

const DEFAULT_DB_PATH = resolve(process.env.PI_CODING_AGENT_DIR ?? join(process.env.HOME ?? "~", ".pi", "agent"), "sessions", "index.json");

function ensureDir(path: string): void {
  if (!existsSync(path)) {
    mkdirSync(path, { recursive: true });
  }
}

function readStore(path: string): Record<string, SessionRecord> {
  if (!existsSync(path)) {
    return {};
  }
  try {
    const raw = readFileSync(path, "utf-8");
    const parsed = JSON.parse(raw);
    if (!isRecord(parsed)) {
      return {};
    }
    return parsed;
  } catch {
    return {};
  }
}

function writeStore(path: string, store: Record<string, SessionRecord>): void {
  ensureDir(join(path, ".."));
  writeFileSync(path, `${JSON.stringify(store, null, 2)}\n`);
}

function isRecord(value: unknown): value is Record<string, SessionRecord> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function mapRecord(record: SessionRecord): SessionRecord {
  return {
    ...record,
    createdAt: new Date(record.createdAt),
    updatedAt: new Date(record.updatedAt),
  };
}

function readMessageStore(path: string): Record<string, SessionMessage[]> {
  if (!existsSync(path)) {
    return {};
  }
  try {
    const raw = readFileSync(path, "utf-8");
    const parsed = JSON.parse(raw);
    if (!isMessageRecord(parsed)) {
      return {};
    }
    return parsed;
  } catch {
    return {};
  }
}

function writeMessageStore(path: string, store: Record<string, SessionMessage[]>): void {
  ensureDir(join(path, ".."));
  writeFileSync(path, `${JSON.stringify(store, null, 2)}\n`);
}

function isMessageRecord(value: unknown): value is Record<string, SessionMessage[]> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function createSessionStore(dbPath = DEFAULT_DB_PATH): SessionStore {
  const storePath = dbPath.replace(/\.db$/, ".json");
  const messageStorePath = storePath.replace(/index\.json$/, "messages.json");
  let cache = readStore(storePath);
  let messageCache = readMessageStore(messageStorePath);

  return {
    async create(input: SessionCreateInput): Promise<SessionRecord> {
      const now = new Date();
      const record: SessionRecord = {
        id: randomUUID(),
        cwd: input.cwd,
        title: input.title ?? `Session ${now.toISOString()}`,
        createdAt: now,
        updatedAt: now,
        messageCount: 0,
        provider: input.provider,
        model: input.model,
      };
      cache[record.id] = record;
      writeStore(storePath, cache);
      return mapRecord(record);
    },

    async get(id: string): Promise<SessionRecord | undefined> {
      const record = cache[id];
      return record ? mapRecord(record) : undefined;
    },

    async list(query?: SessionQuery): Promise<SessionRecord[]> {
      let records = Object.values(cache).map(mapRecord);
      if (query?.cwd) {
        records = records.filter((record) => record.cwd === query.cwd);
      }
      records = records.sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime());
      const limit = query?.limit ?? 50;
      const offset = query?.offset ?? 0;
      return records.slice(offset, offset + limit);
    },

    async update(id: string, input: SessionUpdateInput): Promise<SessionRecord | undefined> {
      const existing = cache[id];
      if (!existing) {
        return undefined;
      }
      const updated: SessionRecord = {
        ...existing,
        ...input,
        updatedAt: input.updatedAt ?? new Date(),
      };
      cache[id] = updated;
      writeStore(storePath, cache);
      return mapRecord(updated);
    },

    async remove(id: string): Promise<boolean> {
      if (!cache[id]) {
        return false;
      }
      delete cache[id];
      delete messageCache[id];
      writeStore(storePath, cache);
      writeMessageStore(messageStorePath, messageCache);
      return true;
    },

    async addMessage(sessionId: string, message: SessionMessage): Promise<SessionWithMessages | undefined> {
      const session = cache[sessionId];
      if (!session) {
        return undefined;
      }
      if (!messageCache[sessionId]) {
        messageCache[sessionId] = [];
      }
      messageCache[sessionId].push(message);
      const updatedCount = messageCache[sessionId].length;
      session.messageCount = updatedCount;
      session.updatedAt = new Date();
      writeStore(storePath, cache);
      writeMessageStore(messageStorePath, messageCache);
      return {
        ...mapRecord(session),
        messages: messageCache[sessionId].map(mapMessage),
      };
    },

    async getMessages(sessionId: string, options?: SessionResumeOptions): Promise<SessionMessage[]> {
      const messages = messageCache[sessionId] ?? [];
      const mapped = messages.map(mapMessage);
      if (!options?.lastMessageId) {
        return mapped.slice(-(options?.limit ?? 50));
      }
      const startIndex = mapped.findIndex((msg) => msg.id === options.lastMessageId);
      if (startIndex === -1) {
        return [];
      }
      const sliced = mapped.slice(startIndex + 1);
      return sliced.slice(-(options?.limit ?? 50));
    },
  };
}

function mapMessage(message: SessionMessage): SessionMessage {
  return {
    ...message,
    createdAt: new Date(message.createdAt),
  };
}
