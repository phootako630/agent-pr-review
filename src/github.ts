import { Octokit } from '@octokit/rest';
import { z } from 'zod';
import { sha } from './contracts.js';
import { run } from './process.js';

export function parsePrUrl(input: string): { owner: string; repo: string; number: number } {
  let url: URL;
  try { url = new URL(input); } catch { throw new Error('Provide a GitHub PR URL: https://github.com/owner/repo/pull/123'); }
  const match = /^\/([a-zA-Z0-9_.-]+)\/([a-zA-Z0-9_.-]+)\/pull\/([1-9]\d*)\/?$/.exec(url.pathname);
  if (url.protocol !== 'https:' || url.host !== 'github.com' || url.username || url.password || !match || !Number.isSafeInteger(Number(match[3]))) {
    throw new Error('Only https://github.com/owner/repo/pull/123 URLs are supported.');
  }
  if (match[1] === '.' || match[1] === '..' || match[2] === '.' || match[2] === '..') throw new Error('Invalid repository name.');
  return { owner: match[1]!, repo: match[2]!, number: Number(match[3]) };
}

export async function githubToken(signal: AbortSignal): Promise<string> {
  const configured = process.env.GH_TOKEN ?? process.env.GITHUB_TOKEN;
  if (configured) return configured;
  try {
    const token = (await run('gh', ['auth', 'token', '--hostname', 'github.com'], { signal, maxBytes: 16000 })).trim();
    if (token) return token;
  } catch {}
  throw new Error('GitHub authentication unavailable. Run gh auth login or set GH_TOKEN.');
}

const metadataSchema = z.object({
  number: z.number().int().positive(), html_url: z.string().url(), title: z.string(), body: z.string().nullable(),
  changed_files: z.number().int().nonnegative(),
  base: z.object({ sha, repo: z.object({ full_name: z.string() }) }),
  head: z.object({ sha }),
});

export async function getPr(url: string, token: string, signal: AbortSignal) {
  const { owner, repo, number } = parsePrUrl(url);
  const client = new Octokit({ auth: token, request: { signal, timeout: 30_000 }, retry: { enabled: false } });
  try {
    const response = await client.rest.pulls.get({ owner, repo, pull_number: number });
    const data = metadataSchema.parse(response.data);
    if (data.base.repo.full_name.toLowerCase() !== `${owner}/${repo}`.toLowerCase()) throw new Error('Repository identity mismatch.');
    return data;
  } catch (error) {
    const status = error && typeof error === 'object' && 'status' in error ? error.status : null;
    if (signal.aborted) throw new Error('GitHub request cancelled or deadline exceeded.');
    throw new Error(`Could not read PR metadata${status ? ` (HTTP ${status})` : ''}. Check URL, repository access, GitHub rate limits, and connectivity.`);
  }
}
