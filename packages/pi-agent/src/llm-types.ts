export type Role = 'system' | 'user' | 'assistant';

export interface Message {
  readonly role: Role;
  readonly content: string;
}

export interface LLMOpts {
  /** Max output tokens. Default 4096. */
  readonly maxTokens?: number;
  /** Sampling temperature. Default 0. */
  readonly temperature?: number;
  /** Per-request timeout in milliseconds. Default 120000. */
  readonly timeoutMs?: number;
}

export interface StructuredRequest {
  readonly messages: readonly Message[];
  /** JSON Schema describing the desired output object. */
  readonly schema: Readonly<Record<string, unknown>>;
  /** Tool/function name presented to the model, e.g. "report_findings". */
  readonly schemaName: string;
  readonly opts?: LLMOpts;
}

export interface LLMUsage {
  readonly inputTokens: number;
  readonly outputTokens: number;
}

export interface StructuredResponse {
  /** Parsed JSON object returned by the model. Unvalidated: caller validates. */
  readonly output: unknown;
  /** Token usage if the provider reports it. */
  readonly usage: LLMUsage | null;
}

export interface LLMProvider {
  readonly name: string;
  complete(req: StructuredRequest): Promise<StructuredResponse>;
}

export type ProviderKind = 'anthropic' | 'openai' | 'ollama' | 'openai-compatible' | 'pi-agent';

export interface ProviderConfig {
  readonly provider: ProviderKind;
  readonly model: string;
  /** Required for anthropic/openai. Optional for openai-compatible/ollama. */
  readonly apiKey?: string;
  /** Required for openai-compatible. Optional override otherwise. */
  readonly baseUrl?: string;
  /** Max retry attempts for retryable errors. Default 3. */
  readonly maxRetries?: number;
}

export type LLMErrorCode =
  | 'auth'
  | 'rate_limit'
  | 'timeout'
  | 'server'
  | 'bad_response'
  | 'network'
  | 'config';

export class LLMError extends Error {
  readonly code: LLMErrorCode;
  readonly retryable: boolean;

  constructor(message: string, code: LLMErrorCode, retryable: boolean, options?: ErrorOptions) {
    super(message, options);
    this.name = 'LLMError';
    this.code = code;
    this.retryable = retryable;
  }
}
