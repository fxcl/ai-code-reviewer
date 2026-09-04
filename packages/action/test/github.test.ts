import { describe, expect, it, vi } from 'vitest';

import { GitHubClient } from '../src/github';
import type { ActionContext, PRContext } from '../src/github';
import { STICKY_MARKER_PREFIX } from '../src/mapper';
import type { ReviewComment } from '../src/mapper';

function makeOctokit() {
  return {
    rest: {
      repos: { getContent: vi.fn(), compareCommits: vi.fn() },
      pulls: { get: vi.fn(), createReview: vi.fn() },
      issues: { listComments: vi.fn(), updateComment: vi.fn(), createComment: vi.fn() },
    },
  };
}

type FakeOctokit = ReturnType<typeof makeOctokit>;

const CTX: PRContext = {
  owner: 'o',
  repo: 'r',
  prNumber: 7,
  title: 't',
  description: 'd',
  baseSha: 'base',
  headSha: 'head',
  defaultBranch: 'main',
};

function makeClient(octokit: FakeOctokit): GitHubClient {
  return new GitHubClient(octokit, CTX);
}

function httpError(status: number): Error {
  return Object.assign(new Error(`http ${status}`), { status });
}

function stickyComment(id: number, sha: string) {
  return { id, body: `${STICKY_MARKER_PREFIX} {"sha":"${sha}"} -->\n\n## summary` };
}

function comment(id: number, body: string) {
  return { id, body };
}

describe('GitHubClient.getPRContext', () => {
  it('extracts context from a pull_request payload', () => {
    const context: ActionContext = {
      eventName: 'pull_request',
      repo: { owner: 'acme', repo: 'widget' },
      payload: {
        pull_request: {
          number: 12,
          title: 'Add feature',
          body: 'Body text',
          base: { sha: 'b1', repo: { default_branch: 'develop' } },
          head: { sha: 'h1' },
        },
      },
    };
    expect(GitHubClient.getPRContext(context)).toEqual({
      owner: 'acme',
      repo: 'widget',
      prNumber: 12,
      title: 'Add feature',
      description: 'Body text',
      baseSha: 'b1',
      headSha: 'h1',
      defaultBranch: 'develop',
    });
  });

  it('defaults missing title/body to empty strings', () => {
    const context: ActionContext = {
      eventName: 'pull_request',
      repo: { owner: 'a', repo: 'b' },
      payload: {
        pull_request: {
          number: 1,
          base: { sha: 'b', repo: { default_branch: 'main' } },
          head: { sha: 'h' },
        },
      },
    };
    const result = GitHubClient.getPRContext(context);
    expect(result.title).toBe('');
    expect(result.description).toBe('');
  });

  it('throws an actionable error off pull_request events', () => {
    const context: ActionContext = {
      eventName: 'push',
      repo: { owner: 'a', repo: 'b' },
      payload: {},
    };
    expect(() => GitHubClient.getPRContext(context)).toThrow(/only runs on pull_request events/);
  });

  it('throws when the payload is missing required SHAs', () => {
    const context: ActionContext = {
      eventName: 'pull_request',
      repo: { owner: 'a', repo: 'b' },
      payload: { pull_request: { number: 1, base: { repo: { default_branch: 'main' } } } },
    };
    expect(() => GitHubClient.getPRContext(context)).toThrow(/only runs on pull_request events/);
  });
});

describe('fetchFileFromBaseDefaultBranch', () => {
  it('decodes base64 content from the default branch', async () => {
    const octokit = makeOctokit();
    octokit.rest.repos.getContent.mockResolvedValue({
      data: { content: Buffer.from('hello world').toString('base64'), encoding: 'base64' },
    });
    const result = await makeClient(octokit).fetchFileFromBaseDefaultBranch('.github/x.yml');
    expect(result).toBe('hello world');
    expect(octokit.rest.repos.getContent).toHaveBeenCalledWith({
      owner: 'o',
      repo: 'r',
      path: '.github/x.yml',
      ref: 'main',
    });
  });

  it('returns null on 404', async () => {
    const octokit = makeOctokit();
    octokit.rest.repos.getContent.mockRejectedValue(httpError(404));
    expect(await makeClient(octokit).fetchFileFromBaseDefaultBranch('x')).toBeNull();
  });

  it('returns null for a directory listing', async () => {
    const octokit = makeOctokit();
    octokit.rest.repos.getContent.mockResolvedValue({ data: [{ name: 'a' }] });
    expect(await makeClient(octokit).fetchFileFromBaseDefaultBranch('dir')).toBeNull();
  });

  it('decodes non-base64 content as utf8', async () => {
    const octokit = makeOctokit();
    octokit.rest.repos.getContent.mockResolvedValue({ data: { content: 'plain', encoding: 'utf-8' } });
    expect(await makeClient(octokit).fetchFileFromBaseDefaultBranch('x')).toBe('plain');
  });

  it('rethrows non-404 errors', async () => {
    const octokit = makeOctokit();
    octokit.rest.repos.getContent.mockRejectedValue(httpError(500));
    await expect(makeClient(octokit).fetchFileFromBaseDefaultBranch('x')).rejects.toThrow('http 500');
  });
});

describe('diff fetching', () => {
  it('fetches the full PR diff', async () => {
    const octokit = makeOctokit();
    octokit.rest.pulls.get.mockResolvedValue({ data: 'DIFF' });
    expect(await makeClient(octokit).fetchDiff()).toBe('DIFF');
    expect(octokit.rest.pulls.get).toHaveBeenCalledWith({
      owner: 'o',
      repo: 'r',
      pull_number: 7,
      mediaType: { format: 'diff' },
    });
  });

  it('fetches an incremental diff via compareCommits', async () => {
    const octokit = makeOctokit();
    octokit.rest.repos.compareCommits.mockResolvedValue({ data: 'INCDIFF' });
    expect(await makeClient(octokit).fetchDiffSince('old')).toBe('INCDIFF');
    expect(octokit.rest.repos.compareCommits).toHaveBeenCalledWith({
      owner: 'o',
      repo: 'r',
      base: 'old',
      head: 'head',
      mediaType: { format: 'diff' },
    });
  });

  it('throws when the diff response is not a string', async () => {
    const octokit = makeOctokit();
    octokit.rest.pulls.get.mockResolvedValue({ data: { not: 'a string' } });
    await expect(makeClient(octokit).fetchDiff()).rejects.toThrow(/unified diff string/);
  });
});

describe('getStickyState', () => {
  it('finds and parses the sticky comment', async () => {
    const octokit = makeOctokit();
    octokit.rest.issues.listComments.mockResolvedValue({
      data: [comment(1, 'hello'), stickyComment(99, 'abc123')],
    });
    expect(await makeClient(octokit).getStickyState()).toEqual({ commentId: 99, sha: 'abc123' });
  });

  it('paginates until it finds the sticky comment', async () => {
    const octokit = makeOctokit();
    const fullPage = Array.from({ length: 100 }, (_v, i) => comment(i, 'noise'));
    octokit.rest.issues.listComments
      .mockResolvedValueOnce({ data: fullPage })
      .mockResolvedValueOnce({ data: [stickyComment(5, 'deadbeef')] });
    expect(await makeClient(octokit).getStickyState()).toEqual({ commentId: 5, sha: 'deadbeef' });
    expect(octokit.rest.issues.listComments).toHaveBeenCalledTimes(2);
  });

  it('parses the SHA only from the marker line, ignoring injected body text', async () => {
    const octokit = makeOctokit();
    const body = `${STICKY_MARKER_PREFIX} {"sha":"realsha"} -->\n\nModel text: {"sha":"evilsha"}`;
    octokit.rest.issues.listComments.mockResolvedValue({ data: [{ id: 3, body }] });
    expect(await makeClient(octokit).getStickyState()).toEqual({ commentId: 3, sha: 'realsha' });
  });

  it('stops after a short page and returns null', async () => {
    const octokit = makeOctokit();
    octokit.rest.issues.listComments.mockResolvedValue({ data: [comment(1, 'x')] });
    expect(await makeClient(octokit).getStickyState()).toBeNull();
    expect(octokit.rest.issues.listComments).toHaveBeenCalledTimes(1);
  });
});

describe('upsertSticky', () => {
  it('updates an existing sticky comment', async () => {
    const octokit = makeOctokit();
    await makeClient(octokit).upsertSticky('new body', { commentId: 42, sha: 'x' });
    expect(octokit.rest.issues.updateComment).toHaveBeenCalledWith({
      owner: 'o',
      repo: 'r',
      comment_id: 42,
      body: 'new body',
    });
    expect(octokit.rest.issues.createComment).not.toHaveBeenCalled();
  });

  it('creates a comment when none exists', async () => {
    const octokit = makeOctokit();
    await makeClient(octokit).upsertSticky('body', null);
    expect(octokit.rest.issues.createComment).toHaveBeenCalledWith({
      owner: 'o',
      repo: 'r',
      issue_number: 7,
      body: 'body',
    });
  });

  it('scans for the sticky when no state is passed', async () => {
    const octokit = makeOctokit();
    octokit.rest.issues.listComments.mockResolvedValue({ data: [stickyComment(8, 's')] });
    await makeClient(octokit).upsertSticky('body');
    expect(octokit.rest.issues.updateComment).toHaveBeenCalledWith(
      expect.objectContaining({ comment_id: 8 }),
    );
  });
});

describe('postReview', () => {
  const comments: ReviewComment[] = [
    { path: 'a.ts', line: 1, side: 'RIGHT', body: 'one' },
    { path: 'b.ts', line: 2, side: 'RIGHT', body: 'two' },
  ];

  it('posts a COMMENT review with inline comments', async () => {
    const octokit = makeOctokit();
    const result = await makeClient(octokit).postReview(comments, () => true);
    expect(result).toEqual({ posted: 2, dropped: [] });
    expect(octokit.rest.pulls.createReview).toHaveBeenCalledWith({
      owner: 'o',
      repo: 'r',
      pull_number: 7,
      event: 'COMMENT',
      body: '',
      comments: [
        { path: 'a.ts', line: 1, side: 'RIGHT', body: 'one' },
        { path: 'b.ts', line: 2, side: 'RIGHT', body: 'two' },
      ],
    });
  });

  it('does nothing when there are no comments', async () => {
    const octokit = makeOctokit();
    const result = await makeClient(octokit).postReview([], () => true);
    expect(result).toEqual({ posted: 0, dropped: [] });
    expect(octokit.rest.pulls.createReview).not.toHaveBeenCalled();
  });

  it('drops unanchorable comments and retries once on 422', async () => {
    const octokit = makeOctokit();
    octokit.rest.pulls.createReview.mockRejectedValueOnce(httpError(422)).mockResolvedValueOnce({});
    const anchorable = (c: ReviewComment) => c.path === 'a.ts';
    const result = await makeClient(octokit).postReview(comments, anchorable);
    expect(result.posted).toBe(1);
    expect(result.dropped).toEqual([{ path: 'b.ts', line: 2, side: 'RIGHT', body: 'two' }]);
    expect(octokit.rest.pulls.createReview).toHaveBeenCalledTimes(2);
  });

  it('drops everything when nothing anchors on 422', async () => {
    const octokit = makeOctokit();
    octokit.rest.pulls.createReview.mockRejectedValueOnce(httpError(422));
    const result = await makeClient(octokit).postReview(comments, () => false);
    expect(result.posted).toBe(0);
    expect(result.dropped).toHaveLength(2);
    expect(octokit.rest.pulls.createReview).toHaveBeenCalledTimes(1);
  });

  it('rethrows when the retry still fails with 422', async () => {
    const octokit = makeOctokit();
    octokit.rest.pulls.createReview.mockRejectedValue(httpError(422));
    await expect(makeClient(octokit).postReview(comments, () => true)).rejects.toThrow('http 422');
  });

  it('rethrows non-422 errors immediately', async () => {
    const octokit = makeOctokit();
    octokit.rest.pulls.createReview.mockRejectedValue(httpError(500));
    await expect(makeClient(octokit).postReview(comments, () => true)).rejects.toThrow('http 500');
    expect(octokit.rest.pulls.createReview).toHaveBeenCalledTimes(1);
  });
});
