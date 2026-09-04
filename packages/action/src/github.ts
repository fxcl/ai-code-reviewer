import { STICKY_MARKER_PREFIX } from './mapper';
import type { ReviewComment } from './mapper';

/** Normalized PR context extracted from the GitHub Actions event payload. */
export interface PRContext {
  readonly owner: string;
  readonly repo: string;
  readonly prNumber: number;
  readonly title: string;
  readonly description: string;
  readonly baseSha: string;
  readonly headSha: string;
  readonly defaultBranch: string;
}

export interface StickyState {
  readonly commentId: number;
  readonly sha: string;
}

export interface PostReviewResult {
  readonly posted: number;
  readonly dropped: readonly ReviewComment[];
}

/** Subset of the Actions `context` object this action depends on. */
export interface ActionContext {
  readonly eventName: string;
  readonly repo: { readonly owner: string; readonly repo: string };
  readonly payload: { readonly pull_request?: unknown };
}

/** The GitHub operations `run` needs; implemented by {@link GitHubClient}. */
export interface ReviewClient {
  readonly context: PRContext;
  fetchFileFromBaseDefaultBranch(path: string): Promise<string | null>;
  fetchDiff(): Promise<string>;
  fetchDiffSince(sha: string): Promise<string>;
  getStickyState(): Promise<StickyState | null>;
  upsertSticky(body: string, existing?: StickyState | null): Promise<void>;
  postReview(
    comments: readonly ReviewComment[],
    isAnchorable: (comment: ReviewComment) => boolean,
  ): Promise<PostReviewResult>;
}

interface OctokitResponse<T = unknown> {
  readonly data: T;
}

interface RepoParams {
  readonly owner: string;
  readonly repo: string;
}

interface DiffMedia {
  readonly mediaType: { readonly format: string };
}

interface ApiComment {
  readonly path: string;
  readonly line: number;
  readonly side: string;
  readonly body: string;
}

/** Structural subset of the hydrated Octokit; a fake is injected in tests. */
export interface OctokitClient {
  readonly rest: {
    readonly repos: {
      getContent(params: RepoParams & { path: string; ref: string }): Promise<OctokitResponse>;
      compareCommits(
        params: RepoParams & { base: string; head: string } & DiffMedia,
      ): Promise<OctokitResponse>;
    };
    readonly pulls: {
      get(params: RepoParams & { pull_number: number } & DiffMedia): Promise<OctokitResponse>;
      createReview(
        params: RepoParams & {
          pull_number: number;
          event: string;
          body: string;
          comments: readonly ApiComment[];
        },
      ): Promise<OctokitResponse>;
    };
    readonly issues: {
      listComments(
        params: RepoParams & { issue_number: number; per_page: number; page: number },
      ): Promise<OctokitResponse>;
      updateComment(
        params: RepoParams & { comment_id: number; body: string },
      ): Promise<OctokitResponse>;
      createComment(
        params: RepoParams & { issue_number: number; body: string },
      ): Promise<OctokitResponse>;
    };
  };
}

const PER_PAGE = 100;
const MAX_STICKY_PAGES = 3;
const NOT_FOUND = 404;
const UNPROCESSABLE = 422;

export class GitHubClient implements ReviewClient {
  readonly context: PRContext;
  private readonly octokit: OctokitClient;

  constructor(octokit: OctokitClient, context: PRContext) {
    this.octokit = octokit;
    this.context = context;
  }

  /** Extract the PR context, throwing an actionable error off pull_request events. */
  static getPRContext(context: ActionContext): PRContext {
    const pr = readPullRequest(context.payload.pull_request);
    if (pr === null) {
      throw new Error(
        'This action only runs on pull_request events. ' +
          'Add `on: pull_request` to the workflow that invokes it.',
      );
    }
    return {
      owner: context.repo.owner,
      repo: context.repo.repo,
      prNumber: pr.number,
      title: pr.title,
      description: pr.description,
      baseSha: pr.baseSha,
      headSha: pr.headSha,
      defaultBranch: pr.defaultBranch,
    };
  }

  async fetchFileFromBaseDefaultBranch(path: string): Promise<string | null> {
    try {
      const response = await this.octokit.rest.repos.getContent({
        owner: this.context.owner,
        repo: this.context.repo,
        path,
        ref: this.context.defaultBranch,
      });
      return decodeContent(response.data);
    } catch (error) {
      if (statusOf(error) === NOT_FOUND) return null;
      throw error;
    }
  }

  async fetchDiff(): Promise<string> {
    const response = await this.octokit.rest.pulls.get({
      owner: this.context.owner,
      repo: this.context.repo,
      pull_number: this.context.prNumber,
      mediaType: { format: 'diff' },
    });
    return asDiffString(response.data);
  }

  async fetchDiffSince(sha: string): Promise<string> {
    const response = await this.octokit.rest.repos.compareCommits({
      owner: this.context.owner,
      repo: this.context.repo,
      base: sha,
      head: this.context.headSha,
      mediaType: { format: 'diff' },
    });
    return asDiffString(response.data);
  }

  async getStickyState(): Promise<StickyState | null> {
    for (let page = 1; page <= MAX_STICKY_PAGES; page += 1) {
      const response = await this.octokit.rest.issues.listComments({
        owner: this.context.owner,
        repo: this.context.repo,
        issue_number: this.context.prNumber,
        per_page: PER_PAGE,
        page,
      });
      const comments = asArray(response.data);
      const found = findSticky(comments);
      if (found !== null) return found;
      if (comments.length < PER_PAGE) break;
    }
    return null;
  }

  async upsertSticky(body: string, existing?: StickyState | null): Promise<void> {
    const state = existing === undefined ? await this.getStickyState() : existing;
    if (state !== null) {
      await this.octokit.rest.issues.updateComment({
        owner: this.context.owner,
        repo: this.context.repo,
        comment_id: state.commentId,
        body,
      });
      return;
    }
    await this.octokit.rest.issues.createComment({
      owner: this.context.owner,
      repo: this.context.repo,
      issue_number: this.context.prNumber,
      body,
    });
  }

  async postReview(
    comments: readonly ReviewComment[],
    isAnchorable: (comment: ReviewComment) => boolean,
  ): Promise<PostReviewResult> {
    if (comments.length === 0) return { posted: 0, dropped: [] };
    try {
      await this.createReview(comments);
      return { posted: comments.length, dropped: [] };
    } catch (error) {
      if (statusOf(error) !== UNPROCESSABLE) throw error;
      return this.retryWithoutUnanchorable(comments, isAnchorable);
    }
  }

  private async retryWithoutUnanchorable(
    comments: readonly ReviewComment[],
    isAnchorable: (comment: ReviewComment) => boolean,
  ): Promise<PostReviewResult> {
    const kept = comments.filter((comment) => isAnchorable(comment));
    const dropped = comments.filter((comment) => !isAnchorable(comment));
    if (kept.length === 0) return { posted: 0, dropped };
    await this.createReview(kept);
    return { posted: kept.length, dropped };
  }

  private async createReview(comments: readonly ReviewComment[]): Promise<void> {
    await this.octokit.rest.pulls.createReview({
      owner: this.context.owner,
      repo: this.context.repo,
      pull_number: this.context.prNumber,
      event: 'COMMENT',
      body: '',
      comments: comments.map((comment) => ({
        path: comment.path,
        line: comment.line,
        side: comment.side,
        body: comment.body,
      })),
    });
  }
}

interface PullRequestFields {
  readonly number: number;
  readonly title: string;
  readonly description: string;
  readonly baseSha: string;
  readonly headSha: string;
  readonly defaultBranch: string;
}

function readPullRequest(value: unknown): PullRequestFields | null {
  const pr = asRecord(value);
  if (pr === null) return null;
  const number = pr['number'];
  const base = asRecord(pr['base']);
  const head = asRecord(pr['head']);
  const baseSha = base === null ? undefined : asString(base['sha']);
  const headSha = head === null ? undefined : asString(head['sha']);
  const defaultBranch = readDefaultBranch(base);
  if (typeof number !== 'number' || baseSha === undefined || headSha === undefined) return null;
  if (defaultBranch === undefined) return null;
  return {
    number,
    title: asString(pr['title']) ?? '',
    description: asString(pr['body']) ?? '',
    baseSha,
    headSha,
    defaultBranch,
  };
}

function readDefaultBranch(base: Record<string, unknown> | null): string | undefined {
  if (base === null) return undefined;
  const repo = asRecord(base['repo']);
  return repo === null ? undefined : asString(repo['default_branch']);
}

function findSticky(comments: readonly unknown[]): StickyState | null {
  for (const item of comments) {
    const comment = asRecord(item);
    if (comment === null) continue;
    const body = asString(comment['body']);
    const id = comment['id'];
    if (typeof id === 'number' && body !== undefined && body.startsWith(STICKY_MARKER_PREFIX)) {
      return { commentId: id, sha: extractSha(body) };
    }
  }
  return null;
}

/**
 * Extract the reviewed SHA from the marker only. We read strictly the first
 * line (the marker owns it) so model-generated summary text below — which could
 * contain a spoofed `{"sha":...}` via prompt injection — cannot alter state.
 */
function extractSha(body: string): string {
  const firstLine = body.split('\n', 1)[0] ?? '';
  const match = /"sha"\s*:\s*"([^"]*)"/.exec(firstLine);
  return match?.[1] ?? '';
}

function decodeContent(data: unknown): string | null {
  const record = asRecord(data);
  if (record === null) return null;
  const content = record['content'];
  if (typeof content !== 'string') return null;
  const encoding = record['encoding'] === 'base64' ? 'base64' : 'utf8';
  return Buffer.from(content, encoding).toString('utf8');
}

function asDiffString(data: unknown): string {
  if (typeof data !== 'string') {
    throw new Error('Expected a unified diff string from the GitHub API.');
  }
  return data;
}

function statusOf(error: unknown): number | null {
  const record = asRecord(error);
  if (record === null) return null;
  const status = record['status'];
  return typeof status === 'number' ? status : null;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (value === null || typeof value !== 'object') return null;
  return value as Record<string, unknown>;
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function asArray(value: unknown): readonly unknown[] {
  return Array.isArray(value) ? value : [];
}
