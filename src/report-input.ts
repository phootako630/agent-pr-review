import { z } from 'zod';
import { configSchema, findingSchema, hash, providerName, resultSchema, selectedReviewers, snapshotSchema, type Report } from './contracts.js';
import { validateFindings } from './diff.js';
import { parsePrUrl } from './github.js';
import { reviewPrompt } from './provider.js';

const digest = z.string().regex(/^[a-f0-9]{64}$/);
const bounded = z.string().max(1000);
const filteredResult = resultSchema.extend({ limitations: z.array(bounded).max(200) });
export const reportInputSchema = z.strictObject({
  schemaVersion: z.literal(2), toolVersion: z.string().min(1).max(100), runId: z.string().min(1).max(100),
  startedAt: z.iso.datetime(), finishedAt: z.iso.datetime(), durationMs: z.number().nonnegative(),
  status: z.enum(['complete', 'partial', 'failed', 'cancelled']), mode: z.enum(['live', 'simulation']),
  outcome: z.enum(['findings', 'no_findings', 'inconclusive']), config: configSchema, configHash: digest,
  contextHash: digest.nullable(), promptHash: digest.nullable(),
  provider: z.strictObject({ name: z.string().max(100), version: bounded.nullable(), model: bounded.nullable() }),
  providers: z.array(z.strictObject({
    name: providerName, version: bounded.nullable(), model: bounded.nullable(), requestedModel: bounded.nullable(),
    startedAt: z.iso.datetime().nullable(), finishedAt: z.iso.datetime().nullable(), durationMs: z.number().nonnegative(),
    status: z.enum(['complete', 'partial', 'failed', 'cancelled', 'timed_out']), contextHash: digest, promptHash: digest,
    rawResult: resultSchema.nullable(), result: filteredResult.nullable(), errors: z.array(bounded).max(100), usage: z.unknown(),
  })).max(3),
  snapshot: snapshotSchema.nullable(),
  result: z.strictObject({ summary: z.string().max(24_100), findings: z.array(findingSchema).max(300), limitations: z.array(z.string().max(1100)).max(600) }).nullable(),
  errors: z.array(bounded).max(300), usage: z.unknown(),
});

// Canonical hashes are publication identities, not signatures or proof of a model call.
export function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map(k => `${JSON.stringify(k)}:${canonical((value as Record<string, unknown>)[k])}`).join(',')}}`;
  return JSON.stringify(value) ?? 'null';
}
export function same(a: unknown, b: unknown): boolean { return canonical(a) === canonical(b); }
export function stableHash(value: unknown): string { return hash(canonical(value)); }

export function parseReport(input: unknown): Report {
  try { reportInputSchema.parse(input); } catch { throw new Error('Report does not match the supported schema version 2.'); }
  // Preserve the original property order: M2 hashes the exact serialized packet.
  const report = input as Report;
  if (!same(configSchema.parse(report.config), report.config) || hash(report.config) !== report.configHash) throw new Error('Report configuration integrity check failed.');
  if (!report.snapshot || hash(report.snapshot) !== report.contextHash || hash(reviewPrompt(report.snapshot)) !== report.promptHash) throw new Error('Report snapshot or prompt integrity check failed.');
  const identity = parsePrUrl(report.snapshot.url);
  if (`${identity.owner}/${identity.repo}`.toLowerCase() !== report.snapshot.repository.toLowerCase() || identity.number !== report.snapshot.pr) throw new Error('Report repository/PR identity does not match its URL.');
  const selected = selectedReviewers(report.config);
  if (selected.length !== report.providers.length) throw new Error('Report reviewer selection is incomplete.');
  for (let i = 0; i < selected.length; i++) {
    const reviewer = selected[i]!, p = report.providers[i]!;
    if (reviewer.name !== p.name || (reviewer.model ?? null) !== p.requestedModel || p.contextHash !== report.contextHash || p.promptHash !== report.promptHash) throw new Error('Report provider provenance does not match the selected reviewers or input.');
    const success = p.status === 'complete' || p.status === 'partial';
    if (success !== !!p.result || success !== !!p.rawResult) throw new Error('Report provider status/result is inconsistent.');
    if (success) {
      if (!p.version || !p.startedAt || !p.finishedAt || p.errors.length || (reviewer.version && reviewer.version !== p.version)) throw new Error('Successful provider provenance is incomplete.');
      const expected = validateFindings(p.rawResult!, report.snapshot);
      if (!same(expected, p.result)) throw new Error('Report filtered findings do not match their original candidates.');
      const expectedStatus = report.snapshot.exclusions.length || expected.limitations.length ? 'partial' : 'complete';
      if (p.status !== expectedStatus) throw new Error('Provider coverage status is inconsistent.');
    }
  }
  const successful = report.providers.filter(p => p.result);
  const aggregate = successful.length ? {
    summary: successful.map(p => `${p.name}: ${p.result!.summary}`).join('\n'),
    findings: successful.flatMap(p => p.result!.findings), limitations: successful.flatMap(p => p.result!.limitations.map(l => `${p.name}: ${l}`)),
  } : null;
  if (!same(report.result, aggregate)) throw new Error('Report aggregate does not match provider results.');
  const expectedStatus = !successful.length ? 'failed' : report.providers.every(p => p.status === 'complete') && !report.errors.length ? 'complete' : 'partial';
  if (report.status !== 'cancelled' && report.status !== expectedStatus) throw new Error('Report completion status is inconsistent.');
  const expectedMode = selected[0]!.name === 'fake' ? 'simulation' : 'live';
  const expectedOutcome = expectedMode === 'simulation' ? 'inconclusive' : report.result?.findings.length ? 'findings' : report.status === 'complete' ? 'no_findings' : 'inconclusive';
  if (report.mode !== expectedMode || report.outcome !== expectedOutcome) throw new Error('Report mode/outcome is inconsistent.');
  return report;
}
