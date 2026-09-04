import { AnthropicProvider } from './providers/anthropic';
import { OpenAIProvider } from './providers/openai';
import { OllamaProvider } from './providers/ollama';
import { LLMError } from './llm-types';
import type { LLMProvider, ProviderConfig } from './llm-types';

export type {
  LLMProvider,
  LLMUsage,
  Message,
  ProviderConfig,
  StructuredRequest,
  StructuredResponse,
  ProviderKind,
  LLMErrorCode,
} from './llm-types';
export { LLMError };

export function createLLMProvider(config: ProviderConfig): LLMProvider {
  switch (config.provider) {
    case 'anthropic':
      return new AnthropicProvider(config);
    case 'openai':
      return new OpenAIProvider(config);
    case 'openai-compatible':
      return new OpenAIProvider(config);
    case 'ollama':
      return new OllamaProvider(config);
    default:
      throw new LLMError(`Unknown provider kind "${String(config.provider)}"`, 'config', false);
  }
}
