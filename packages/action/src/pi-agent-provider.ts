import { LLMError, createPiAgent, type PiAgentOptions } from '@acr/pi-agent';
import type { LLMProvider, ProviderConfig, StructuredRequest, StructuredResponse, Message } from '@acr/pi-agent';

export class PiAgentProvider implements LLMProvider {
  readonly name: string;

  constructor(readonly config: ProviderConfig) {
    this.name = `pi-agent/${config.provider}/${config.model}`;
  }

  async complete(request: StructuredRequest): Promise<StructuredResponse> {
    const prompt = request.messages.map((message: Message) => formatMessage(message)).join('\n\n');
    const options: PiAgentOptions = {
      cwd: process.cwd(),
      provider: mapProvider(this.config.provider),
      model: this.config.model,
      apiKey: this.config.apiKey,
      baseURL: this.config.baseUrl,
      permission: 'plan',
      sandbox: 'read-only',
    };
    const agent = createPiAgent(options);
    try {
      const events = agent.send(prompt);
      let output = '';
      for await (const event of events) {
        if (event.type === 'text') {
          output += event.text;
        } else if (event.type === 'error') {
          throw new LLMError(event.message, 'server', false);
        }
      }
      return {
        output: { content: output },
        usage: { inputTokens: 0, outputTokens: 0 },
      };
    } finally {
      await agent.stop();
    }
  }
}

function formatMessage(message: Message): string {
  return `<${message.role}>\n${message.content}\n</${message.role}>`;
}

function mapProvider(provider: string): PiAgentOptions['provider'] {
  switch (provider) {
    case 'anthropic':
      return 'anthropic';
    case 'openai':
      return 'openai';
    case 'openai-compatible':
      return 'openai-compatible';
    case 'ollama':
      return 'ollama';
    default:
      return 'openai-compatible';
  }
}
