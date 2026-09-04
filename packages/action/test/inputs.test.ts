import { afterEach, describe, expect, it, vi } from 'vitest';

import { parseRawInputs, readInputs } from '../src/inputs';

type InputMap = Record<string, string>;

function makeGetInput(map: InputMap): (name: string) => string {
  return (name) => map[name] ?? '';
}

describe('parseRawInputs', () => {
  it('parses a fully specified set of inputs', () => {
    const getInput = makeGetInput({
      github_token: 'tok',
      provider: 'openai',
      model: 'gpt-x',
      api_key: 'sk-secret',
      base_url: 'https://api.example.com',
      config_path: '.github/custom.yml',
      language: 'zh-CN',
      severity_threshold: 'high',
      max_comments: '10',
      include: 'src/**, packages/**',
      exclude: 'dist/**\n**/*.lock',
      max_files: '25',
      incremental: 'false',
      fail_on: 'critical',
      concurrency: '2',
    });
    const inputs = parseRawInputs(getInput, {});
    expect(inputs).toEqual({
      githubToken: 'tok',
      provider: 'openai',
      model: 'gpt-x',
      apiKey: 'sk-secret',
      baseUrl: 'https://api.example.com',
      configPath: '.github/custom.yml',
      language: 'zh-CN',
      severityThreshold: 'high',
      maxComments: 10,
      include: ['src/**', 'packages/**'],
      exclude: ['dist/**', '**/*.lock'],
      maxFiles: 25,
      incremental: false,
      failOn: 'critical',
      concurrency: 2,
    });
  });

  it('treats blank inputs as unset so the config file is not shadowed', () => {
    const inputs = parseRawInputs(makeGetInput({}), {});
    expect(inputs.provider).toBeUndefined();
    expect(inputs.model).toBeUndefined();
    expect(inputs.incremental).toBeUndefined();
    expect(inputs.failOn).toBeUndefined();
    expect(inputs.apiKey).toBeUndefined();
    expect(inputs.language).toBeUndefined();
    expect(inputs.maxComments).toBeUndefined();
    expect(inputs.include).toBeUndefined();
    // configPath is not a config-file key, so it keeps its built-in default.
    expect(inputs.configPath).toBe('.github/ai-code-reviewer.yml');
  });

  it('falls back to a generic env key when the provider input is unset', () => {
    const inputs = parseRawInputs(makeGetInput({}), { ANTHROPIC_API_KEY: 'a-key' });
    expect(inputs.apiKey).toBe('a-key');
  });

  it('masks the api key the moment it is resolved', () => {
    const onSecret = vi.fn();
    parseRawInputs(makeGetInput({ api_key: 'sk-live-123' }), {}, onSecret);
    expect(onSecret).toHaveBeenCalledExactlyOnceWith('sk-live-123');
  });

  it('does not call the secret hook when no key or token is present', () => {
    const onSecret = vi.fn();
    parseRawInputs(makeGetInput({ provider: 'ollama' }), {}, onSecret);
    expect(onSecret).not.toHaveBeenCalled();
  });

  it('masks the github token on read (defense in depth)', () => {
    const onSecret = vi.fn();
    parseRawInputs(makeGetInput({ github_token: 'ghs_abc' }), {}, onSecret);
    expect(onSecret).toHaveBeenCalledWith('ghs_abc');
  });

  it('masks both the github token and the api key', () => {
    const onSecret = vi.fn();
    parseRawInputs(makeGetInput({ github_token: 'ghs_abc', api_key: 'sk-1' }), {}, onSecret);
    expect(onSecret).toHaveBeenCalledWith('ghs_abc');
    expect(onSecret).toHaveBeenCalledWith('sk-1');
  });

  it.each([
    ['anthropic', { ANTHROPIC_API_KEY: 'a-key' }, 'a-key'],
    ['openai', { OPENAI_API_KEY: 'o-key' }, 'o-key'],
    ['openai-compatible', { LLM_API_KEY: 'llm-key', OPENAI_API_KEY: 'o-key' }, 'llm-key'],
    ['openai-compatible', { OPENAI_API_KEY: 'o-key' }, 'o-key'],
    ['ollama', { LLM_API_KEY: 'llm-key' }, 'llm-key'],
  ])('falls back to env for %s', (provider, env, expected) => {
    const inputs = parseRawInputs(makeGetInput({ provider }), env);
    expect(inputs.apiKey).toBe(expected);
  });

  it('prefers the explicit api_key input over env', () => {
    const inputs = parseRawInputs(makeGetInput({ api_key: 'direct' }), { ANTHROPIC_API_KEY: 'env' });
    expect(inputs.apiKey).toBe('direct');
  });

  it.each(['true', 'false'])('parses boolean %s', (value) => {
    const inputs = parseRawInputs(makeGetInput({ incremental: value }), {});
    expect(inputs.incremental).toBe(value === 'true');
  });

  it('throws on a non-boolean incremental', () => {
    expect(() => parseRawInputs(makeGetInput({ incremental: 'yes' }), {})).toThrow(
      /"incremental" must be "true" or "false"/,
    );
  });

  it.each(['0', '-3', '1.5', 'abc'])('rejects invalid positive integer %s', (value) => {
    expect(() => parseRawInputs(makeGetInput({ max_comments: value }), {})).toThrow(
      /"max_comments" must be a positive integer/,
    );
  });

  it('drops empty list entries and trims', () => {
    const inputs = parseRawInputs(makeGetInput({ include: ' a , , b ,\n c \n' }), {});
    expect(inputs.include).toEqual(['a', 'b', 'c']);
  });
});

describe('readInputs', () => {
  const original = { ...process.env };

  afterEach(() => {
    process.env = { ...original };
  });

  it('reads from the real Actions env and applies defaults', () => {
    for (const key of Object.keys(process.env)) {
      if (key.startsWith('INPUT_')) delete process.env[key];
    }
    process.env.INPUT_GITHUB_TOKEN = 'gh-tok';
    const inputs = readInputs();
    expect(inputs.githubToken).toBe('gh-tok');
    expect(inputs.provider).toBeUndefined();
    expect(inputs.configPath).toBe('.github/ai-code-reviewer.yml');
  });
});
