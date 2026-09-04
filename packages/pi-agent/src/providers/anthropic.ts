import { withRetry } from '../retry';
import {
  asArray,
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
const DEFAULT_BASE_URL = 'https://api.anthropic.com';
const ANTHROPIC_VERSION = '2023-06-01';

type Sleep = (ms: number) => Promise<void>;

export class AnthropicProvider implements LLMProvider {
  readonly name = 'anthropic';
  private readonly apiKey: string;
  private readonly model: string;
  private readonly baseUrl: string;
  private readonly maxRetries: number;
  private readonly sleep?: Sleep;

  constructor(config: ProviderConfig, sleep?: Sleep) {
    this.apiKey = config.apiKey ?? '';
    this.model = config.model;
    this.baseUrl = config.baseUrl ?? DEFAULT_BASE_URL;
    this.maxRetries = config.maxRetries ?? DEFAULT_MAX_RETRIES;
    this.sleep = sleep;
  }

  complete(req: StructuredRequest): Promise<StructuredResponse> {
    return withRetry(() => this.send(req), { maxRetries: this.maxRetries, sleep: this.sleep });
  }

  private async send(req: StructuredRequest): Promise<StructuredResponse> {
    const data = await postJson({
      url: `${this.baseUrl}/v1/messages`,
      headers: { 'x-api-key': this.apiKey, 'anthropic-version': ANTHROPIC_VERSION },
      body: this.buildBody(req),
      timeoutMs: req.opts?.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      redact: [this.apiKey],
    });
    return parseResponse(data);
  }

  private buildBody(req: StructuredRequest): Record<string, unknown> {
    const system = mergeSystem(req.messages);
    const body: Record<string, unknown> = {
      model: this.model,
      max_tokens: req.opts?.maxTokens ?? DEFAULT_MAX_TOKENS,
      temperature: req.opts?.temperature ?? DEFAULT_TEMPERATURE,
      messages: req.messages
        .filter((m) => m.role !== 'system')
        .map((m) => ({ role: m.role, content: m.content })),
      tools: [
        {
          name: req.schemaName,
          description: `Report the result by calling ${req.schemaName}.`,
          input_schema: req.schema,
        },
      ],
      tool_choice: { type: 'tool', name: req.schemaName },
    };
    if (system) body.system = system;
    return body;
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
  const content = asArray(root?.content);
  const output = content ? findToolUseInput(content) : undefined;
  if (output === undefined) {
    throw new LLMError('Anthropic response contained no tool_use block', 'bad_response', false);
  }
  return { output, usage: extractUsage(root?.usage, 'input_tokens', 'output_tokens') };
}

function findToolUseInput(content: readonly unknown[]): unknown {
  for (const block of content) {
    const rec = asRecord(block);
    if (rec && rec.type === 'tool_use' && 'input' in rec) return rec.input;
  }
  return undefined;
}