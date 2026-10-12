import { Octokit } from '@octokit/rest';
import { z } from 'zod';
import { setTimeout as delay } from 'node:timers/promises';
import { sha } from './contracts.js';
import type { PlannedComment } from './publication-plan.js';

export type Publisher = { id: number; login: string };
export type CurrentPr = { state: 'open' | 'closed'; draft: boolean; repository: string; pr: number; headSha: string; baseSha: string };
export type RemoteReview = { id: number; userId: number | null; body: string; commitId: string | null; state: string; url: string };
export type RemoteComment = { id: number; userId: number | null; body: string; originalCommitId: string | null; path: string; originalLine: number | null; originalSide: string | null; replyTo: number | null };
export class PublicationApiError extends Error {
  constructor(public ambiguous: boolean, public status: number | null) {
    super(`GitHub publication request failed${status ? ` (HTTP ${status})` : ''}.${ambiguous ? ' Outcome is uncertain; remote reconciliation is required before any new create request.' : ' Check repository permissions and request validity.'}`);
  }
}
export interface PublicationApi {
  identity(): Promise<Publisher>;
  current(): Promise<CurrentPr>;
  reviews(): Promise<RemoteReview[]>;
  comments(): Promise<RemoteComment[]>;
  create(summary: string, comments: PlannedComment[], headSha: string): Promise<RemoteReview>;
  update(id: number, body: string): Promise<void>;
}

export function githubPublicationApi(token: string, owner: string, repo: string, pr: number, signal: AbortSignal): PublicationApi {
  const client = new Octokit({ auth: token, request: { signal, timeout: 30_000 }, retry: { enabled: false } });
  const target = { owner, repo, pull_number: pr };
  const user = z.object({ id: z.number().int().positive(), login: z.string().max(100) });
  const reviewSchema = z.object({ id: z.number().int().positive(), user: user.nullable(), body: z.string().nullable(), commit_id: sha.nullable(), state: z.string(), html_url: z.string().url() });
  function remoteReview(input: unknown): RemoteReview {
    const data = reviewSchema.parse(input);
    return { id: data.id, userId: data.user?.id ?? null, body: data.body ?? '', commitId: data.commit_id, state: data.state, url: data.html_url };
  }
  async function request<T>(operation: () => Promise<T>, write = false): Promise<T> {
    for (let attempt = 0; ; attempt++) {
      try { return await operation(); }
      catch (error) {
        const code = error && typeof error === 'object' && 'status' in error && typeof error.status === 'number' ? error.status : null;
        if (!write && !signal.aborted && attempt < 2 && (code === null || code >= 500)) { await delay(100 * 2 ** attempt, undefined, { signal }); continue; }
        throw new PublicationApiError(write && (code === null || code >= 500), code);
      }
    }
  }
  return {
    identity: () => request(async () => user.parse((await client.rest.users.getAuthenticated()).data)),
    current: () => request(async () => {
      const data = z.object({ state: z.enum(['open', 'closed']), draft: z.boolean(), number: z.number().int().positive(),
        head: z.object({ sha }), base: z.object({ sha, repo: z.object({ full_name: z.string() }) }) }).parse((await client.rest.pulls.get(target)).data);
      return { state: data.state, draft: data.draft, repository: data.base.repo.full_name, pr: data.number, headSha: data.head.sha, baseSha: data.base.sha };
    }),
    reviews: () => request(async () => (await client.paginate(client.rest.pulls.listReviews, { ...target, per_page: 100 })).map(remoteReview)),
    comments: () => request(async () => (await client.paginate(client.rest.pulls.listReviewComments, { ...target, per_page: 100 })).map(input => {
      const data = z.object({ id: z.number().int().positive(), user: user.nullable(), body: z.string(), original_commit_id: sha.nullable(),
        path: z.string(), original_line: z.number().int().positive().nullable(), side: z.string().nullable(), in_reply_to_id: z.number().int().positive().optional() }).parse(input);
      return { id: data.id, userId: data.user?.id ?? null, body: data.body, originalCommitId: data.original_commit_id,
        path: data.path, originalLine: data.original_line, originalSide: data.side, replyTo: data.in_reply_to_id ?? null };
    })),
    create: (body, comments, commit_id) => request(async () => remoteReview((await client.rest.pulls.createReview({ ...target, body, commit_id, event: 'COMMENT',
      comments: comments.map(({ path, side, line, body }) => ({ path, side, line, body })) })).data), true),
    update: (comment_id, body) => request(async () => { await client.rest.pulls.updateReviewComment({ owner, repo, comment_id, body }); }, true),
  };
}
