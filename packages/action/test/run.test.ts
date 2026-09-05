import { describe, expect, it, vi } from 'vitest';

import { LLMError } from '@acr/pi-agent';
import type { LLMProvider } from '@acr/pi-agent';

import type { PRContext, ReviewClient } from '../src/github';
import type { RawInputs } from '../src/inputs';
import { run } from '../src/run';
import type { RunDeps } from '../src/run';

const HEAD_SHA = 'HEADSHA';

const DIFF = [
  'diff --git a/src/app.ts b/src/app.ts',
  'index 1111111..2222222 100644',
  '--- a/src/app.ts',
  '+++ b/src/app.ts',
  '@@ -1,2 +1,3 @@',
  ' const a = 1;',
  '+const b = 2;',
  ' const d = 4;',
  '',
].join('\n');

const HIGH_OUTPUT = {
  findings: [
    {
      line: 2,
      severity: 'high',
      category: 'correctness',
      message: 'Potential bug',
      rationale: 'Because reasons.',
      suggestion: 'const b = 2;',
      confidence: 0.9,
    },
  ],
};

const CRITICAL_OUTPUT = {
  findings: [
    {
      line: 2,
      severity: 'critical',
      category: 'security',
      message: 'SQL injection',
      rationale: 'Unsanitized input.',
      suggestion: null,
      confidence: 0.95,
    },
  ],
};

const CONTEXT: PRContext = {
  owner: 'o',
  repo: 'r',
  prNumber: 7,
  title: 'PR title',
  description: 'PR body',
  baseSha: 'BASESHA',
  headSha: HEAD_SHA,
  defaultBranch: 'main',
};

function baseInputs(overrides: Partial<RawInputs> = {}): RawInputs {
  return {
    githubToken: 'tok',
    provider: 'anthropic',
    model: 'claude-sonnet-5',
    apiKey: 'sk-test',
    baseUrl: undefined,
    configPath: '.github/ai-code-reviewer.yml',
    language: undefined,
    severityThreshold: undefined,
    maxComments: undefined,
    include: undefined,
    exclude: undefined,
    maxFiles: undefined,
    maxCompletionTokens: undefined,
    incremental: true,
    failOn: 'none',
    concurrency: undefined,
    ...overrides,
  };
}

function makeClient(overrides: Partial<ReviewClient> = {}): ReviewClient {
  return {
    context: CONTEXT,
    fetchFileFromBaseDefaultBranch: vi.fn(() => Promise.resolve(null)),
    fetchDiff: vi.fn(() => Promise.resolve(DIFF)),
    fetchDiffSince: vi.fn(() => Promise.resolve(DIFF)),
    getStickyState: vi.fn(() => Promise.resolve(null)),
    upsertSticky: vi.fn(() => Promise.resolve()),
    postReview: vi.fn((comments: readonly unknown[]) =>
      Promise.resolve({ posted: comments.length, dropped: [] }),
    ),
    ...overrides,
  };
}

function makeProvider(output: unknown): LLMProvider {
  return {
    name: 'stub',
    complete: vi.fn(() =>
      Promise.resolve({ output, usage: { inputTokens: 5, outputTokens: 3 } }),
    ),
  };
}

function makeDeps(overrides: Partial<RunDeps> = {}): RunDeps {
  return {
    inputs: baseInputs(),
    client: makeClient(),
    log: { info: vi.fn(), warning: vi.fn(), error: vi.fn() },
    setOutput: vi.fn(),
    setFailed: vi.fn(),
    writeSummary: vi.fn(),
    providerFactory: () => makeProvider(HIGH_OUTPUT),
    ...overrides,
  };
}

describe('run', () => {
  it('posts a review, records the sticky, and sets outputs on first pass', async () => {
    const client = makeClient();
    const deps = makeDeps({ client });
    await run(deps);

    const postArgs = vi.mocked(client.postReview).mock.calls[0]?.[0] ?? [];
    expect(postArgs).toHaveLength(1);
    expect(postArgs[0]).toMatchObject({ path: 'src/app.ts', line: 2, side: 'RIGHT' });
    expect(postArgs[0]?.body).toContain('Potential bug');

    const stickyBody = vi.mocked(client.upsertSticky).mock.calls[0]?.[0] ?? '';
    expect(stickyBody).toContain(`{"sha":"${HEAD_SHA}"}`);

    expect(deps.setOutput).toHaveBeenCalledWith('findings_count', '1');
    expect(deps.setOutput).toHaveBeenCalledWith('critical_count', '0');
    expect(deps.setFailed).not.toHaveBeenCalled();
    expect(deps.writeSummary).toHaveBeenCalledOnce();
  });

  it('skips when the head SHA was already reviewed', async () => {
    const client = makeClient({
      getStickyState: vi.fn(() => Promise.resolve({ commentId: 1, sha: HEAD_SHA, partial: false })),
    });
    const deps = makeDeps({ client });
    await run(deps);

    expect(deps.log.info).toHaveBeenCalledWith(expect.stringContaining('already reviewed'));
    expect(deps.setOutput).toHaveBeenCalledWith('findings_count', '0');
    expect(client.fetchDiff).not.toHaveBeenCalled();
    expect(client.postReview).not.toHaveBeenCalled();
    expect(client.upsertSticky).not.toHaveBeenCalled();
  });

  it('fetches an incremental diff from the recorded SHA', async () => {
    const client = makeClient({
      getStickyState: vi.fn(() => Promise.resolve({ commentId: 1, sha: 'OLDSHA', partial: false })),
    });
    await run(makeDeps({ client }));

    expect(client.fetchDiffSince).toHaveBeenCalledWith('OLDSHA');
    expect(client.fetchDiff).not.toHaveBeenCalled();
  });

  it('re-reviews the full diff when the sticky is partial even at the same SHA', async () => {
    const client = makeClient({
      getStickyState: vi.fn(() => Promise.resolve({ commentId: 1, sha: HEAD_SHA, partial: true })),
    });
    const deps = makeDeps({ client });
    await run(deps);

    expect(deps.log.info).not.toHaveBeenCalledWith(expect.stringContaining('already reviewed'));
    expect(client.fetchDiff).toHaveBeenCalledOnce();
    expect(client.fetchDiffSince).not.toHaveBeenCalled();
    expect(client.postReview).toHaveBeenCalledOnce();
  });

  it('fetches the full diff when incremental is disabled', async () => {
    const client = makeClient({
      getStickyState: vi.fn(() => Promise.resolve({ commentId: 1, sha: 'OLDSHA', partial: false })),
    });
    await run(makeDeps({ client, inputs: baseInputs({ incremental: false }) }));

    expect(client.fetchDiff).toHaveBeenCalledOnce();
    expect(client.fetchDiffSince).not.toHaveBeenCalled();
  });

  it('falls back to a full diff when the incremental diff fails', async () => {
    const client = makeClient({
      getStickyState: vi.fn(() => Promise.resolve({ commentId: 1, sha: 'OLDSHA', partial: false })),
      fetchDiffSince: vi.fn(() => Promise.reject(new Error('Not Found'))),
    });
    const deps = makeDeps({ client });
    await run(deps);

    expect(client.fetchDiffSince).toHaveBeenCalledWith('OLDSHA');
    expect(client.fetchDiff).toHaveBeenCalledOnce();
    expect(deps.log.warning).toHaveBeenCalledWith(expect.stringContaining('falling back'));
    expect(client.postReview).toHaveBeenCalledOnce();
    expect(deps.setFailed).not.toHaveBeenCalled();
  });

  it('fails the check on a critical finding when fail_on=critical', async () => {
    const deps = makeDeps({
      inputs: baseInputs({ failOn: 'critical' }),
      providerFactory: () => makeProvider(CRITICAL_OUTPUT),
    });
    await run(deps);

    expect(deps.setOutput).toHaveBeenCalledWith('critical_count', '1');
    expect(deps.setFailed).toHaveBeenCalledWith(expect.stringContaining('critical'));
  });

  it('does not fail on a critical finding when fail_on=none', async () => {
    const deps = makeDeps({ providerFactory: () => makeProvider(CRITICAL_OUTPUT) });
    await run(deps);
    expect(deps.setFailed).not.toHaveBeenCalled();
  });

  it('records a clean sticky without posting inline comments when there are no findings', async () => {
    const client = makeClient();
    const deps = makeDeps({ client, providerFactory: () => makeProvider({ findings: [] }) });
    await run(deps);

    expect(client.postReview).not.toHaveBeenCalled();
    expect(client.upsertSticky).toHaveBeenCalledOnce();
    expect(deps.setOutput).toHaveBeenCalledWith('findings_count', '0');
    expect(deps.setOutput).toHaveBeenCalledWith('critical_count', '0');
    expect(deps.setFailed).not.toHaveBeenCalled();
  });

  it('setFailed with an actionable message on an auth error', async () => {
    const deps = makeDeps({
      providerFactory: () => {
        throw new LLMError('invalid key', 'auth', false);
      },
    });
    await run(deps);
    expect(deps.setFailed).toHaveBeenCalledWith(
      expect.stringContaining('ANTHROPIC_API_KEY'),
    );
  });

  it('names the OpenAI secret for an openai provider config error', async () => {
    const deps = makeDeps({
      inputs: baseInputs({ provider: 'openai' }),
      providerFactory: () => {
        throw new LLMError('missing key', 'config', false);
      },
    });
    await run(deps);
    expect(deps.setFailed).toHaveBeenCalledWith(expect.stringContaining('OPENAI_API_KEY'));
  });

  it('names the generic secret for an ollama config error', async () => {
    const deps = makeDeps({
      inputs: baseInputs({ provider: 'ollama', apiKey: undefined }),
      providerFactory: () => {
        throw new LLMError('missing base url', 'config', false);
      },
    });
    await run(deps);
    expect(deps.setFailed).toHaveBeenCalledWith(expect.stringContaining('LLM_API_KEY'));
  });

  it('records dropped comments in the sticky body on a 422 retry', async () => {
    const client = makeClient({
      postReview: vi.fn(() =>
        Promise.resolve({
          posted: 0,
          dropped: [{ path: 'src/app.ts', line: 2, side: 'RIGHT' as const, body: 'x' }],
        }),
      ),
    });
    await run(makeDeps({ client }));

    const stickyBody = vi.mocked(client.upsertSticky).mock.calls[0]?.[0] ?? '';
    expect(stickyBody).toContain('could not be anchored');
    expect(stickyBody).toContain('`src/app.ts:2`');
  });

  it('records a nothing-to-review sticky for an empty diff', async () => {
    const client = makeClient({ fetchDiff: vi.fn(() => Promise.resolve('')) });
    const deps = makeDeps({ client });
    await run(deps);

    const stickyBody = vi.mocked(client.upsertSticky).mock.calls[0]?.[0] ?? '';
    expect(stickyBody).toContain('Nothing to review');
    expect(client.postReview).not.toHaveBeenCalled();
    expect(deps.setOutput).toHaveBeenCalledWith('findings_count', '0');
  });

  it('surfaces config warnings through the logger', async () => {
    const client = makeClient({
      fetchFileFromBaseDefaultBranch: vi.fn(() => Promise.resolve('unknown_key: 1\n')),
    });
    const deps = makeDeps({ client });
    await run(deps);
    expect(deps.log.warning).toHaveBeenCalledWith(expect.stringContaining('unknown_key'));
  });

  it('reads a rules file referenced by the config', async () => {
    const fetchFile = vi.fn((path: string) =>
      Promise.resolve(
        path === '.github/ai-code-reviewer.yml' ? 'rules_file: .github/rules.md' : '# Guidelines',
      ),
    );
    const client = makeClient({ fetchFileFromBaseDefaultBranch: fetchFile });
    await run(makeDeps({ client }));
    expect(fetchFile).toHaveBeenCalledWith('.github/rules.md');
  });

  it('reports non-LLM errors verbatim through setFailed', async () => {
    const client = makeClient({
      fetchDiff: vi.fn(() => {
        throw new Error('network is down');
      }),
    });
    const deps = makeDeps({ client });
    await run(deps);
    expect(deps.setFailed).toHaveBeenCalledWith('network is down');
  });
});
