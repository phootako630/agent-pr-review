import { randomUUID } from 'node:crypto';
import { mkdir, open, readdir, rename, rm, unlink, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { z } from 'zod';
import type { Report, Snapshot } from './contracts.js';
import { githubToken, parsePrUrl } from './github.js';
import { PublicationApiError, githubPublicationApi, type CurrentPr, type PublicationApi, type Publisher, type RemoteComment, type RemoteReview } from './publication-api.js';
import { publicationPlan, renderPreview, type PlannedComment, type Policy, type PublicationPlan } from './publication-plan.js';
import { parseReport, same, stableHash } from './report-input.js';
import { readJson } from './review.js';
import { capturePr } from './snapshot.js';

const journalSchema = z.strictObject({
  schemaVersion: z.literal(1), publicationId: z.string().regex(/^[a-f0-9]{64}$/),
  reportHash: z.string(), policyHash: z.string(), snapshotKey: z.string(), repository: z.string(), pr: z.number().int().positive(),
  publisher: z.strictObject({ id: z.number().int().positive(), login: z.string() }),
  status: z.enum(['prepared', 'sending', 'uncertain', 'complete', 'superseded']), attemptedCreate: z.boolean(),
  reviewId: z.number().int().positive().nullable(), reviewUrl: z.string().nullable(), commentIds: z.array(z.number().int().positive()).max(50),
  startedAt: z.iso.datetime(), updatedAt: z.iso.datetime(), diagnostics: z.array(z.string().max(1000)).max(100),
});
export type Journal = z.infer<typeof journalSchema>;

async function atomicJson(path: string, value: unknown): Promise<void> {
  const temporary = `${path}.${randomUUID()}.tmp`;
  try { await writeFile(temporary, JSON.stringify(value, null, 2) + '\n', { mode: 0o600 }); await rename(temporary, path); }
  finally { try { await unlink(temporary); } catch {} }
}
function fresh(current: CurrentPr, plan: PublicationPlan): void {
  const t = plan.target;
  if (current.repository.toLowerCase() !== t.repository.toLowerCase() || current.pr !== t.pr) throw new Error('Remote repository/PR identity does not match the report.');
  if (current.state !== 'open' || current.draft) throw new Error('Publication requires an open, ready PR.');
  if (current.headSha !== t.headSha || current.baseSha !== t.baseSha) throw new Error('Stale report: PR head or base SHA changed. Review the new snapshot; findings will not be remapped.');
}
function marked(body: string, marker: string): boolean { return body.trimEnd().endsWith(marker); }
function findReview(reviews: RemoteReview[], publisher: Publisher, plan: PublicationPlan): RemoteReview | undefined {
  const matches = reviews.filter(r => r.userId === publisher.id && marked(r.body, plan.summaryMarker));
  if (matches.length > 1) throw new Error('Multiple owned review markers exist. Inspect the remote state; no additional review will be created.');
  const found = matches[0];
  if (found && (found.commitId !== plan.target.headSha || found.state !== 'COMMENTED')) throw new Error('Owned review marker has an unexpected commit or review state.');
  return found;
}
function findComment(comments: RemoteComment[], publisher: Publisher, plan: PublicationPlan, desired: PlannedComment): RemoteComment | undefined {
  const matches = comments.filter(c => c.userId === publisher.id && c.replyTo === null && marked(c.body, desired.marker));
  if (matches.length > 1) throw new Error('Multiple owned finding markers exist. Inspect the remote state; comments will not be duplicated.');
  const found = matches[0];
  if (found && (found.originalCommitId !== plan.target.headSha || found.path !== desired.path || found.originalSide !== desired.side || found.originalLine !== desired.line)) throw new Error('Owned finding marker has an unexpected original commit or anchor.');
  return found;
}

async function guardPriorCreates(state: string, plan: PublicationPlan): Promise<void> {
  for (const filename of await readdir(state)) {
    if (!/^[a-f0-9]{64}\.json$/.test(filename) || filename === `${plan.publicationId}.json`) continue;
    let prior: Journal;
    try { prior = journalSchema.parse(await readJson(join(state, filename), 128_000)); }
    catch { throw new Error('A prior publication journal is invalid. Inspect the PR state directory before creating another review.'); }
    if (filename !== `${prior.publicationId}.json` || prior.repository.toLowerCase() !== plan.target.repository.toLowerCase() || prior.pr !== plan.target.pr) throw new Error('A prior publication journal has an inconsistent PR identity.');
    if (prior.snapshotKey === plan.snapshotKey && prior.attemptedCreate && prior.status !== 'complete') {
      throw new Error(`An unresolved prior publication exists for this PR snapshot (${prior.publicationId}). Reconcile that report with its original policy before creating a new publication; changing the report or comment budget does not reset uncertainty.`);
    }
  }
}

export async function executePublication(options: {
  report: Report; policy: Policy; api: PublicationApi; stateDirectory: string; outputDirectory: string;
  capture: (directory: string) => Promise<Snapshot>; signal: AbortSignal; dryRun?: boolean;
}): Promise<{ plan: PublicationPlan; journal: Journal | null; status: 'dry_run' | 'published' | 'reconciled' }> {
  const report = parseReport(options.report);
  const plan = publicationPlan(report, options.policy);
  const state = resolve(options.stateDirectory, stableHash({ repository: plan.target.repository.toLowerCase(), pr: plan.target.pr }).slice(0, 32));
  await mkdir(state, { recursive: true });
  const lockPath = join(state, 'publisher.lock');
  let lock;
  try { lock = await open(lockPath, 'wx', 0o600); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') throw new Error('Another local publisher holds this PR lock. If it crashed, verify no publisher is running before removing publisher.lock.');
    throw error;
  }
  const captureDirectory = join(state, `capture-${randomUUID().slice(0, 16)}`);
  const journalPath = join(state, `${plan.publicationId}.json`);
  let journal: Journal | null = null;
  let wroteReview = false;
  async function persist(): Promise<void> {
    journal!.updatedAt = new Date().toISOString(); await atomicJson(journalPath, journal);
  }
  async function remote() {
    // Independent reads can run concurrently; mutations remain sequential.
    const [reviews, comments] = await Promise.all([options.api.reviews(), options.api.comments()]);
    return { reviews, comments };
  }
  async function ensureFresh(): Promise<void> { fresh(await options.api.current(), plan); if (options.signal.aborted) throw new Error('Publication cancelled or deadline exceeded.'); }
  try {
    await lock.writeFile(JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString(), publicationId: plan.publicationId }));
    await ensureFresh();
    await mkdir(captureDirectory);
    const captured = await options.capture(captureDirectory);
    if (!same(captured, report.snapshot)) throw new Error('Fresh Git source, diff, coverage, or PR metadata does not match the report packet. Review again before publishing.');
    await ensureFresh();
    await mkdir(resolve(options.outputDirectory), { recursive: true });
    await atomicJson(join(options.outputDirectory, 'publication-plan.json'), plan);
    await writeFile(join(options.outputDirectory, 'publication-preview.md'), renderPreview(plan), { mode: 0o600 });
    if (options.dryRun) return { plan, journal: null, status: 'dry_run' };
    const publisher = await options.api.identity();
    try { journal = journalSchema.parse(await readJson(journalPath, 128_000)); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw new Error('Publication journal is invalid or unreadable. Inspect it before retrying.');
    }
    if (journal) {
      if (journal.publicationId !== plan.publicationId || journal.reportHash !== plan.reportHash || journal.policyHash !== plan.policyHash || journal.snapshotKey !== plan.snapshotKey || journal.repository !== plan.target.repository || journal.pr !== plan.target.pr || journal.publisher.id !== publisher.id) throw new Error('Publication journal identity or publisher does not match this invocation.');
    } else {
      journal = { schemaVersion: 1, publicationId: plan.publicationId, reportHash: plan.reportHash, policyHash: plan.policyHash,
        snapshotKey: plan.snapshotKey, repository: plan.target.repository, pr: plan.target.pr, publisher,
        status: 'prepared', attemptedCreate: false, reviewId: null, reviewUrl: null, commentIds: [],
        startedAt: new Date().toISOString(), updatedAt: new Date().toISOString(), diagnostics: [] };
      await persist();
    }
    let listed = await remote();
    let review = findReview(listed.reviews, publisher, plan);
    if (!review && (journal.attemptedCreate || journal.reviewId !== null)) throw new Error('A prior create outcome is uncertain or its remote marker disappeared. No create retry was sent. Inspect GitHub and retry reconciliation later.');
    const missing = plan.comments.filter(c => !findComment(listed.comments, publisher, plan, c));
    if (review && missing.length) throw new Error('Owned review exists but some expected comments are missing. No repeat create was sent; inspect deletion or delayed remote visibility.');
    if (!review) {
      await guardPriorCreates(state, plan);
      await ensureFresh();
      journal.status = 'sending'; journal.attemptedCreate = true; await persist();
      try {
        const created = await options.api.create(plan.summary, missing, plan.target.headSha);
        journal.reviewId = created.id; journal.reviewUrl = created.url; await persist(); wroteReview = true;
      } catch (error) {
        if (error instanceof PublicationApiError && !error.ambiguous) { journal.status = 'prepared'; journal.attemptedCreate = false; }
        else journal.status = 'uncertain';
        journal.diagnostics.push(error instanceof PublicationApiError ? error.message : 'Create response unavailable; outcome uncertain.');
        await persist();
        if (journal.status !== 'uncertain' || options.signal.aborted) throw new Error(journal.diagnostics.at(-1));
        // Read-only reconciliation after a lost response. Never blindly repeat POST.
      }
      listed = await remote();
      review = findReview(listed.reviews, publisher, plan);
      if (!review) { journal.status = 'uncertain'; await persist(); throw new Error('Review creation is not confirmed remotely. No create retry was sent; retry reconciliation later.'); }
    }
    journal.reviewId = review.id; journal.reviewUrl = review.url;
    for (const desired of plan.comments) {
      const existing = findComment(listed.comments, publisher, plan, desired);
      if (!existing) { journal.status = 'uncertain'; await persist(); throw new Error('Submitted review is missing an expected inline comment. No duplicate create was sent.'); }
      if (existing.body !== desired.body) {
        await ensureFresh(); journal.status = 'sending'; await persist();
        await options.api.update(existing.id, desired.body);
      }
    }
    await ensureFresh();
    const finalState = await remote();
    const confirmed = findReview(finalState.reviews, publisher, plan);
    if (!confirmed) throw new Error('Final remote review reconciliation failed.');
    journal.commentIds = plan.comments.map(c => {
      const found = findComment(finalState.comments, publisher, plan, c);
      if (!found || found.body !== c.body) throw new Error('Final remote finding reconciliation failed.');
      return found.id;
    });
    journal.status = 'complete'; await persist();
    return { plan, journal, status: wroteReview ? 'published' : 'reconciled' };
  } catch (error) {
    if (journal) {
      if (error instanceof Error && /Stale report/.test(error.message)) journal.status = 'superseded';
      else if (journal.status === 'sending') journal.status = 'uncertain';
      await persist();
    }
    throw error;
  } finally {
    try { await rm(captureDirectory, { recursive: true, force: true }); }
    finally { await lock.close(); await unlink(lockPath); }
  }
}

export async function publish(options: {
  reportPath: string; stateDirectory: string; outputDirectory?: string; allowPartial?: boolean; maxComments?: number; dryRun?: boolean; signal: AbortSignal;
}) {
  const report = parseReport(await readJson(options.reportPath, 16_000_000));
  const policy = { allowPartial: options.allowPartial ?? false, maxComments: options.maxComments ?? 20 };
  // Refuse malformed/simulated/incomplete reports before acquiring credentials.
  publicationPlan(report, policy);
  const token = await githubToken(options.signal);
  const identity = parsePrUrl(report.snapshot!.url);
  const api = githubPublicationApi(token, identity.owner, identity.repo, identity.number, options.signal);
  return executePublication({ report, policy, api, stateDirectory: options.stateDirectory,
    outputDirectory: options.outputDirectory ?? dirname(resolve(options.reportPath)), dryRun: options.dryRun, signal: options.signal,
    capture: directory => capturePr(report.snapshot!.url, token, directory, report.config, options.signal) });
}
