import { withRetry } from '../retry';
import {
  asRecord,
  DEFAULT_MAX_RETRIES,
  DEFAULT_MAX_TOKENS,
  DEFAULT_TEMPERATURE,
  DEFAULT_TIMEOUT_MS,
  extractUsage,
  postJson,
} from '../http';
import { LLMError } from '../llm-types';
import type {
  LLMProvider,
  Message,
  ProviderConfig,
  StructuredRequest,
  StructuredResponse,
} from '../llm-types';

const DEFAULT_BASE_URL = 'http://localhost:11434';
const DEFAULT_MODEL = 'llama3';

type Sleep = (ms: number) => Promise<void>;

export class OllamaProvider implements LLMProvider {
  readonly name = 'ollama';
  private readonly apiKey: string;
  private readonly model: string;
  private readonly baseUrl: string;
  private readonly maxRetries: number;
  private readonly sleep?: Sleep;

  constructor(config: ProviderConfig, sleep?: Sleep) {
    this.apiKey = config.apiKey ?? '';
    this.model = config.model ?? DEFAULT_MODEL;
    this.baseUrl = (config.baseUrl ?? DEFAULT_BASE_URL).replace(/\/$/, '');
    this.maxRetries = config.maxRetries ?? DEFAULT_MAX_RETRIES;
    this.sleep = sleep;
  }

  complete(req: StructuredRequest): Promise<StructuredResponse> {
    return withRetry(() => this.send(req), { maxRetries: this.maxRetries, sleep: this.sleep });
  }

  private async send(req: StructuredRequest): Promise<StructuredResponse> {
    const data = await postJson({
      url: `${this.baseUrl}/api/chat`,
      headers: this.apiKey ? { Authorization: `Bearer ${this.apiKey}` } : undefined,
      body: this.buildBody(req),
      timeoutMs: req.opts?.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      redact: this.apiKey ? [this.apiKey] : undefined,
    });
    return parseResponse(data);
  }

  private buildBody(req: StructuredRequest): Record<string, unknown> {
    const system = mergeSystem(req.messages);
    return {
      model: this.model,
      max_tokens: req.opts?.maxTokens ?? DEFAULT_MAX_TOKENS,
      temperature: req.opts?.temperature ?? DEFAULT_TEMPERATURE,
      messages: req.messages.map((m) => ({ role: m.role, content: m.content })),
      stream: false,
      format: 'json',
      options: {
        num_ctx: 8192,
      },
      system,
    };
  }
}

function mergeSystem(messages: readonly Message[]): string {
  return messages
    .filter((m) => m.role === 'system')
    .map((m) => m.content)
    .join('\n\n');
}

function parseResponse(data: unknown): StructuredResponse {
  const root = asRecord(data);
  const message = asRecord(root?.message);
  const raw = typeof message?.content === 'string' ? message.content : undefined;
  if (!raw) {
    throw new LLMError('Ollama response contained no message content', 'bad_response', false);
  }
  let output: unknown;
  try {
    output = JSON.parse(raw);
  } catch {
    throw new LLMError('Ollama message content is not valid JSON', 'bad_response', false);
  }
  return {
    output,
    usage: extractUsage(root?.usage, 'prompt_eval_count', 'eval_count'),
  };
}
