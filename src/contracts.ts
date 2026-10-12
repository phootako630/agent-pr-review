import { createHash } from 'node:crypto';
import { z } from 'zod';

export const VERSION = '0.1.0-dev';
export const sha = z.string().regex(/^[0-9a-f]{40}$/);
export const repoPath = z.string().min(1).max(1024).refine(p =>
  !p.startsWith('/') && !p.includes('\\') && !p.includes(':') &&
  !p.split('/').some(s => s === '..' || s === '.' || s === '') &&
  !/[\x00-\x1f\x7f]/.test(p), 'Expected a safe repository-relative path');

export const configSchema = z.strictObject({
  reviewer: z.enum(['codex', 'fake']).default('codex'),
  model: z.string().regex(/^[a-zA-Z0-9._:/-]+$/).optional(),
  timeoutSeconds: z.number().int().min(5).max(3600).default(600),
  maxFiles: z.number().int().min(1).max(500).default(50),
  maxFileBytes: z.number().int().min(128).max(1_000_000).default(100_000),
  maxContextBytes: z.number().int().min(1024).max(4_000_000).default(500_000),
  contextFiles: z.array(repoPath).max(50).default([]),
});
export type Config = z.infer<typeof configSchema>;

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

export type Report = {
  schemaVersion: 1;
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
  snapshot: Snapshot | null;
  result: ReviewResult | null;
  errors: string[];
  usage: unknown;
};
