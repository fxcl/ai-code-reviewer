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
  ProviderConfig,
  StructuredRequest,
  StructuredResponse,
} from '../llm-types';

const DEFAULT_BASE_URL = 'https://api.openai.com';

type Sleep = (ms: number) => Promise<void>;

export class OpenAIProvider implements LLMProvider {
  readonly name = 'openai';
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
      url: `${this.baseUrl}/v1/chat/completions`,
      headers: { Authorization: `Bearer ${this.apiKey}` },
      body: this.buildBody(req),
      timeoutMs: req.opts?.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      redact: [this.apiKey],
    });
    return parseResponse(data);
  }

  private buildBody(req: StructuredRequest): Record<string, unknown> {
    return {
      model: this.model,
      max_tokens: req.opts?.maxTokens ?? DEFAULT_MAX_TOKENS,
      temperature: req.opts?.temperature ?? DEFAULT_TEMPERATURE,
      messages: req.messages.map((m) => ({ role: m.role, content: m.content })),
      tools: [
        {
          type: 'function',
          function: {
            name: req.schemaName,
            description: `Report the result by calling ${req.schemaName}.`,
            parameters: req.schema,
          },
        },
      ],
      tool_choice: { type: 'function', function: { name: req.schemaName } },
    };
  }
}

function parseResponse(data: unknown): StructuredResponse {
  const root = asRecord(data);
  const choices = asArray(root?.choices);
  const choice = choices && choices[0] ? asRecord(choices[0]) : null;
  const message = choice && choice.message ? asRecord(choice.message) : null;
  const toolCalls = message ? asArray(message.tool_calls) : [];
  const firstCall = toolCalls[0] ? asRecord(toolCalls[0]) : null;
  const toolCall = firstCall?.function ? asRecord(firstCall.function) : null;
  const legacyCall = message && message.function_call ? asRecord(message.function_call) : null;
  const raw =
    typeof toolCall?.arguments === "string"
      ? toolCall.arguments
      : typeof legacyCall?.arguments === "string"
        ? legacyCall.arguments
        : null;
  if (!raw) {
    throw new LLMError('OpenAI response contained no tool call arguments', 'bad_response', false);
  }
  let output: unknown;
  try {
    output = JSON.parse(raw);
  } catch {
    throw new LLMError('OpenAI function_call arguments are not valid JSON', 'bad_response', false);
  }
  return {
    output,
    usage: extractUsage(root?.usage, 'prompt_tokens', 'completion_tokens'),
  };
}