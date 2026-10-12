import { createHash } from 'node:crypto';
import { z } from 'zod';

export const VERSION = '0.2.0-dev';
export const sha = z.string().regex(/^[0-9a-f]{40}$/);
export const repoPath = z.string().min(1).max(1024).refine(p =>
  !p.startsWith('/') && !p.includes('\\') && !p.includes(':') &&
  !p.split('/').some(s => s === '..' || s === '.' || s === '') &&
  !/[\x00-\x1f\x7f]/.test(p), 'Expected a safe repository-relative path');

export const providerName = z.enum(['codex', 'claude', 'grok', 'fake']);
const modelId = z.string().regex(/^[a-zA-Z0-9._:/-]+$/);
const authMode = z.enum(['api-key', 'browser']);
export const reviewerSchema = z.strictObject({
  name: providerName,
  model: modelId.optional(),
  auth: authMode.optional(),
  version: z.string().regex(/^[a-zA-Z0-9 .()_-]+$/).max(100).optional(),
});
export type Reviewer = z.infer<typeof reviewerSchema>;
export const configSchema = z.strictObject({
  reviewer: providerName.default('codex'),
  model: modelId.optional(),
  auth: authMode.optional(),
  reviewers: z.array(reviewerSchema).min(1).max(3).optional(),
  concurrency: z.number().int().min(1).max(3).default(2),
  providerTimeoutSeconds: z.number().int().min(5).max(3600).default(600),
  timeoutSeconds: z.number().int().min(5).max(3600).default(600),
  maxFiles: z.number().int().min(1).max(500).default(50),
  maxFileBytes: z.number().int().min(128).max(1_000_000).default(100_000),
  maxContextBytes: z.number().int().min(1024).max(4_000_000).default(500_000),
  contextFiles: z.array(repoPath).max(50).default([]),
});
export type Config = z.infer<typeof configSchema>;

export function selectedReviewers(config: Config): Reviewer[] {
  if (config.reviewers && (config.model || config.auth || config.reviewer !== 'codex')) throw new Error('Use reviewers or reviewer/model/auth, not both configuration styles.');
  const reviewers = config.reviewers ?? [{ name: config.reviewer, model: config.model, auth: config.auth }];
  if (reviewers.some(r => r.auth && (r.name === 'codex' || r.name === 'fake'))) throw new Error('Explicit auth selection is supported for Claude and Grok. Codex uses its own login or OPENAI_API_KEY.');
  if (new Set(reviewers.map(r => r.name)).size !== reviewers.length) throw new Error('Each provider may appear only once.');
  if (reviewers.some(r => r.name === 'fake') && reviewers.length > 1) throw new Error('The fake reviewer cannot be mixed with live reviewers.');
  if (reviewers.some(r => r.name !== 'fake' && !r.model)) throw new Error('Set an explicit accessible model for every live reviewer.');
  return reviewers;
}

export const fileSchema = z.strictObject({
  path: repoPath,
  previousPath: repoPath.nullable(),
  status: z.string(),
  patch: z.string(),
  before: z.string().nullable(),
  after: z.string().nullable(),
  kind: z.enum(['change', 'context']),
});
export type ReviewFile = z.infer<typeof fileSchema>;
export const snapshotSchema = z.strictObject({
  repository: z.string().regex(/^[\w.-]+\/[\w.-]+$/),
  pr: z.number().int().positive(),
  url: z.string().url(),
  title: z.string(),
  body: z.string(),
  baseSha: sha,
  headSha: sha,
  mergeBaseSha: sha,
  totalChangedFiles: z.number().int().nonnegative(),
  files: z.array(fileSchema),
  exclusions: z.array(z.strictObject({ path: z.string(), reason: z.string() })),
});
export type Snapshot = z.infer<typeof snapshotSchema>;

export const findingSchema = z.strictObject({
  title: z.string().min(1).max(200),
  severity: z.enum(['critical', 'high', 'medium', 'low']),
  path: repoPath,
  side: z.enum(['LEFT', 'RIGHT']),
  line: z.number().int().positive(),
  description: z.string().min(1).max(4000),
  trigger: z.string().min(1).max(2000),
  impact: z.string().min(1).max(2000),
  evidence: z.string().min(1).max(4000),
});
export const resultSchema = z.strictObject({
  summary: z.string().min(1).max(8000),
  findings: z.array(findingSchema).max(100),
  limitations: z.array(z.string().min(1).max(1000)).max(100),
});
export type ReviewResult = z.infer<typeof resultSchema>;
export const outputJsonSchema = z.toJSONSchema(resultSchema, { target: 'draft-7' });

export function hash(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

export type ProviderReport = {
  name: Reviewer['name'];
  version: string | null;
  model: string | null;
  requestedModel: string | null;
  startedAt: string | null;
  finishedAt: string | null;
  durationMs: number;
  status: 'complete' | 'partial' | 'failed' | 'cancelled' | 'timed_out';
  contextHash: string;
  promptHash: string;
  rawResult: ReviewResult | null;
  result: ReviewResult | null;
  errors: string[];
  usage: unknown;
};

export type Report = {
  schemaVersion: 2;
  toolVersion: string;
  runId: string;
  startedAt: string;
  finishedAt: string;
  durationMs: number;
  status: 'complete' | 'partial' | 'failed' | 'cancelled';
  mode: 'live' | 'simulation';
  outcome: 'findings' | 'no_findings' | 'inconclusive';
  config: Config;
  configHash: string;
  contextHash: string | null;
  promptHash: string | null;
  provider: { name: string; version: string | null; model: string | null };
  providers: ProviderReport[];
  snapshot: Snapshot | null;
  result: ReviewResult | null;
  errors: string[];
  usage: unknown;
};
