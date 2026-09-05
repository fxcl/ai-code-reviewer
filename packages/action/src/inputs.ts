import * as core from '@actions/core';

/**
 * Raw, parsed-but-unresolved Action inputs. A blank input is treated as
 * "unset" (`undefined`) so config merging can fall back to the repo config
 * file and then to built-in defaults — never letting an action.yml default
 * silently shadow a config-file value. `configPath` keeps a default because it
 * is not a config-file key. API keys are masked via setSecret on read.
 */
export interface RawInputs {
  readonly githubToken: string;
  readonly provider: string | undefined;
  readonly model: string | undefined;
  readonly apiKey: string | undefined;
  readonly baseUrl: string | undefined;
  readonly configPath: string;
  readonly language: string | undefined;
  readonly severityThreshold: string | undefined;
  readonly maxComments: number | undefined;
  readonly include: readonly string[] | undefined;
  readonly exclude: readonly string[] | undefined;
  readonly maxFiles: number | undefined;
  readonly maxCompletionTokens: number | undefined;
  readonly incremental: boolean | undefined;
  readonly failOn: string | undefined;
  readonly concurrency: number | undefined;
}

type GetInput = (name: string) => string;
type Env = Record<string, string | undefined>;
type OnSecret = (secret: string) => void;

const DEFAULT_CONFIG_PATH = '.github/ai-code-reviewer.yml';

const noop: OnSecret = () => {
  /* masking is optional for pure callers */
};

/**
 * Pure input reader. `getInput` and `env` are injected so tests can drive both;
 * `onSecret` is called the moment an API key is resolved so it can be masked
 * before anything else runs.
 */
export function parseRawInputs(getInput: GetInput, env: Env, onSecret: OnSecret = noop): RawInputs {
  const provider = optional(getInput('provider'));
  const githubToken = getInput('github_token');
  // Belt-and-suspenders: the platform already masks the built-in token, but
  // mask it ourselves too so it can never surface in our logs or errors.
  if (githubToken !== '') onSecret(githubToken);
  const apiKey = resolveApiKey(getInput, env, provider);
  if (apiKey !== undefined) onSecret(apiKey);
  return {
    githubToken,
    provider,
    model: optional(getInput('model')),
    apiKey,
    baseUrl: optional(getInput('base_url')),
    configPath: orDefault(getInput('config_path'), DEFAULT_CONFIG_PATH),
    language: optional(getInput('language')),
    severityThreshold: optional(getInput('severity_threshold')),
    maxComments: parsePositiveInt('max_comments', getInput('max_comments')),
    include: parseList(getInput('include')),
    exclude: parseList(getInput('exclude')),
    maxFiles: parsePositiveInt('max_files', getInput('max_files')),
    maxCompletionTokens: parsePositiveInt('max_tokens', getInput('max_tokens')),
    incremental: parseOptionalBoolean('incremental', getInput('incremental')),
    failOn: optional(getInput('fail_on')),
    concurrency: parsePositiveInt('concurrency', getInput('concurrency')),
  };
}

/** Thin wiring over the real Action runtime; masks the key on read. */
export function readInputs(): RawInputs {
  return parseRawInputs(core.getInput, process.env, core.setSecret);
}

function optional(raw: string): string | undefined {
  const trimmed = raw.trim();
  return trimmed === '' ? undefined : trimmed;
}

function orDefault(raw: string, fallback: string): string {
  const trimmed = raw.trim();
  return trimmed === '' ? fallback : trimmed;
}

function parseOptionalBoolean(name: string, raw: string): boolean | undefined {
  const trimmed = raw.trim();
  if (trimmed === '') return undefined;
  if (trimmed === 'true') return true;
  if (trimmed === 'false') return false;
  throw new Error(`Input "${name}" must be "true" or "false", but got "${raw}".`);
}

function parsePositiveInt(name: string, raw: string): number | undefined {
  const trimmed = raw.trim();
  if (trimmed === '') return undefined;
  const value = Number(trimmed);
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`Input "${name}" must be a positive integer, but got "${raw}".`);
  }
  return value;
}

function parseList(raw: string): readonly string[] | undefined {
  const items = raw
    .split(/[,\n]/)
    .map((item) => item.trim())
    .filter((item) => item !== '');
  return items.length === 0 ? undefined : items;
}

function resolveApiKey(
  getInput: GetInput,
  env: Env,
  provider: string | undefined,
): string | undefined {
  const direct = getInput('api_key').trim();
  if (direct !== '') return direct;
  return envApiKey(provider, env);
}

function envApiKey(provider: string | undefined, env: Env): string | undefined {
  switch (provider) {
    case 'anthropic':
      return env['ANTHROPIC_API_KEY'];
    case 'openai':
      return env['OPENAI_API_KEY'];
    case 'openai-compatible':
      return env['LLM_API_KEY'] ?? env['OPENAI_API_KEY'];
    case 'ollama':
      return env['LLM_API_KEY'];
    default:
      // Provider not set at input time: try the generic key, then provider keys.
      return env['LLM_API_KEY'] ?? env['ANTHROPIC_API_KEY'] ?? env['OPENAI_API_KEY'];
  }
}
