import { randomUUID } from 'node:crypto';
import { mkdir, open, readFile, readdir, rename, rm, unlink, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { Octokit } from '@octokit/rest';
import { z } from 'zod';
import { configSchema, selectedReviewers, sha, VERSION, type Config, type Report, type Reviewer, type Snapshot } from './contracts.js';
import { githubToken, parsePrUrl } from './github.js';
import { parseReport, stableHash } from './report-input.js';
import { review, readJson } from './review.js';
import { capturePr } from './snapshot.js';
import { publish } from './publish.js';

export const repositoryName = z.string().regex(/^[\w.-]+\/[\w.-]+$/).refine(value => !value.split('/').some(part => part === '.' || part === '..'));
const positive = z.number().int().positive().safe();
const policySchema = z.strictObject({ allowPartial: z.boolean().default(true), maxComments: z.number().int().min(1).max(50).default(10) });
export const workerConfigSchema = z.strictObject({ review: configSchema, publication: policySchema.default({ allowPartial: true, maxComments: 10 }),
  pollSeconds: z.number().int().min(5).max(3600).default(30), maxActivePrs: z.number().int().min(1).max(3).default(1) });
export type WorkerConfig = z.infer<typeof workerConfigSchema>;
export function browserWorkerConfig(input: unknown): WorkerConfig {
  const config = workerConfigSchema.parse(input);
  if (selectedReviewers(config.review).some(r => r.name === 'fake' || r.auth !== 'browser')) throw new Error('Local worker requires auth=browser for every live reviewer. API keys, automatic auth selection, and simulation are refused.');
  return config;
}
export type WorkerPr = { number: number; url: string; title: string; body: string; headSha: string; baseSha: string; headRepository: string | null; baseRef: string; draft: boolean; state: string };
const prSchema = z.strictObject({ number: positive, url: z.string().url(), title: z.string(), body: z.string(), headSha: sha, baseSha: sha,
  headRepository: repositoryName.nullable(), baseRef: z.string(), draft: z.boolean(), state: z.string() });
const jobSchema = z.strictObject({ schemaVersion: z.literal(1), key: z.string().regex(/^[a-f0-9]{64}$/), repository: repositoryName, pr: prSchema,
  config: configSchema, policy: policySchema, toolVersion: z.string().max(100), runId: z.string().regex(/^[a-f0-9-]{1,50}$/),
  status: z.enum(['reviewing', 'reviewed', 'publishing', 'published', 'previewed', 'failed', 'blocked', 'cancelled', 'stale']),
  updatedAt: z.iso.datetime(), detail: z.string().max(1000), reviewUrl: z.string().url().nullable() });
export type WorkerJob = z.infer<typeof jobSchema>;
const pauseSchema = z.partialRecord(z.enum(['codex', 'claude', 'grok']), z.strictObject({ since: z.iso.datetime(), reason: z.string().max(1000) }));
type Pauses = z.infer<typeof pauseSchema>;
export interface WorkerDependencies {
  capture(pr: WorkerPr, config: Config, directory: string, signal: AbortSignal): Promise<Snapshot>;
  review(snapshot: Snapshot, config: Config, runId: string, output: string, signal: AbortSignal, paused: Partial<Record<Reviewer['name'], string>>): Promise<Report>;
  publish(reportPath: string, policy: WorkerConfig['publication'], directory: string, signal: AbortSignal, preview: boolean): Promise<{ status: string; url: string | null }>;
}
export function workerRevision(repository: string, pr: WorkerPr, config: Config, policy: WorkerConfig['publication'], toolVersion = VERSION): string {
  return stableHash({ repository, pr: pr.number, head: pr.headSha, base: pr.baseSha, title: pr.title, body: pr.body, config, policy, toolVersion });
}
async function atomic(path: string, value: unknown) {
  const temporary = `${path}.${randomUUID()}.tmp`;
  try { await writeFile(temporary, JSON.stringify(value, null, 2) + '\n', { mode: 0o600 }); await rename(temporary, path); }
  finally { try { await unlink(temporary); } catch {} }
}
function controlled(error: unknown): string {
  // Native diagnostics are already sanitized. Never save raw remote API payloads.
  if (error instanceof Error && error.name !== 'ZodError' && !('request' in error)) return error.message.slice(0, 1000);
  return 'Operation failed. Check GitHub permissions, rate limits, source freshness, or supported configuration.';
}
type Active = { key: string; pr: number; controller: AbortController; phase: 'review' | 'publish'; promise: Promise<void> };

export class WorkerEngine {
  readonly jobs = new Map<string, WorkerJob>();
  readonly active = new Map<number, Active>();
  pauses: Pauses = {};
  fatalError: Error | null = null;
  readonly blockedPrs = new Set<number>();
  private loggedSkips = new Set<string>();
  private retry = new Set<string>();
  constructor(readonly repository: string, readonly defaultBranch: string, readonly config: WorkerConfig, readonly root: string,
    readonly dependencies: WorkerDependencies, readonly signal: AbortSignal, readonly preview: boolean, readonly log: (message: string) => void = console.log) {}

  async initialize(options: { retryFailed?: boolean; resumeProviders?: boolean } = {}) {
    await mkdir(join(this.root, 'jobs'), { recursive: true }); await mkdir(join(this.root, 'runs'), { recursive: true });
    try { this.pauses = pauseSchema.parse(await readJson(join(this.root, 'paused-providers.json'), 64_000)); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw new Error('Worker provider pause state is invalid; inspect it before resuming.'); }
    if (options.resumeProviders) { this.pauses = {}; await atomic(join(this.root, 'paused-providers.json'), this.pauses); this.log('PROVIDERS_RESUMED: browser login only; no API fallback.'); }
    for (const file of await readdir(join(this.root, 'jobs'))) {
      if (!/^[a-f0-9]{64}\.json$/.test(file)) continue;
      const job = jobSchema.parse(await readJson(join(this.root, 'jobs', file), 128_000));
      if (job.repository !== this.repository || `${job.key}.json` !== file
        || job.key !== workerRevision(job.repository, job.pr, job.config, job.policy, job.toolVersion)) throw new Error('Worker job identity is inconsistent; inspect saved state.');
      browserWorkerConfig({ review: job.config, publication: job.policy });
      if (job.status === 'reviewing') {
        try { await readFile(this.reportPath(job)); }
        catch { job.status = 'failed'; job.detail = 'Interrupted before a durable report was saved.'; await this.persist(job); }
      }
      this.jobs.set(job.key, job);
      if (options.retryFailed && ['failed', 'blocked', 'cancelled'].includes(job.status)) this.retry.add(job.key);
    }
  }
  private reportPath(job: WorkerJob) { return join(this.root, 'runs', job.runId, 'report.json'); }
  private async persist(job: WorkerJob) {
    job.updatedAt = new Date().toISOString(); await atomic(join(this.root, 'jobs', `${job.key}.json`), job);
  }
  async tick(prs: WorkerPr[]) {
    if (this.fatalError) throw this.fatalError;
    if (this.signal.aborted) return;
    const eligible = new Map<number, WorkerPr>();
    for (const input of prs) {
      const pr = prSchema.parse(input), identity = parsePrUrl(pr.url);
      if (`${identity.owner}/${identity.repo}` !== this.repository || identity.number !== pr.number) throw new Error('PR listing identity mismatch.');
      const skip = pr.state !== 'open' ? 'SKIPPED_CLOSED' : pr.draft ? 'SKIPPED_DRAFT' : pr.headRepository !== this.repository ? 'SKIPPED_FORK' : pr.baseRef !== this.defaultBranch ? 'SKIPPED_BASE_BRANCH' : null;
      if (!skip) eligible.set(pr.number, pr);
      else if (!this.loggedSkips.has(`${pr.number}:${skip}`)) { this.loggedSkips.add(`${pr.number}:${skip}`); this.log(`${skip}: PR ${pr.number}.`); }
    }
    for (const number of this.blockedPrs) if (!eligible.has(number)) this.blockedPrs.delete(number);
    for (const active of this.active.values()) {
      const current = eligible.get(active.pr);
      if (active.phase === 'review' && (!current || active.key !== workerRevision(this.repository, current, this.config.review, this.config.publication))) {
        active.controller.abort(); this.log(`CANCEL_SUPERSEDED: PR ${active.pr}.`);
      }
    }
    for (const pr of [...eligible.values()].sort((a, b) => a.number - b.number)) {
      if (this.active.size >= this.config.maxActivePrs) break;
      if (this.active.has(pr.number)) continue;
      const key = workerRevision(this.repository, pr, this.config.review, this.config.publication);
      let job = this.jobs.get(key);
      if (job && (job.status === 'published' || (job.status === 'previewed' && this.preview) || (['failed', 'blocked', 'cancelled', 'stale'].includes(job.status) && !this.retry.has(key)))) continue;
      if (!job) {
        const prior = [...this.jobs.values()].find(saved => saved.pr.number === pr.number && saved.pr.headSha === pr.headSha && saved.pr.baseSha === pr.baseSha
          && ['reviewed', 'publishing', 'blocked'].includes(saved.status));
        if (prior) {
          if (!this.blockedPrs.has(pr.number)) this.log(`BLOCKED_PRIOR: PR ${pr.number}; recover the original saved report/configuration before a new review.`);
          this.blockedPrs.add(pr.number); continue;
        }
        if (selectedReviewers(this.config.review).every(r => this.pauses[r.name as keyof Pauses])) {
          if (!this.blockedPrs.has(pr.number)) this.log(`BLOCKED_PROVIDERS: PR ${pr.number}; all selected reviewers are paused.`);
          this.blockedPrs.add(pr.number); continue;
        }
        job = { schemaVersion: 1, key, repository: this.repository, pr, config: this.config.review, policy: this.config.publication, toolVersion: VERSION,
          runId: `${key.slice(0, 8)}-${randomUUID().slice(0, 8)}`, status: 'reviewing', updatedAt: new Date().toISOString(), detail: '', reviewUrl: null };
        this.jobs.set(key, job); await this.persist(job);
      }
      this.blockedPrs.delete(pr.number);
      const controller = new AbortController();
      const active: Active = { key, pr: pr.number, controller, phase: job.status === 'publishing' ? 'publish' : 'review', promise: Promise.resolve() };
      this.active.set(pr.number, active);
      const signal = AbortSignal.any([this.signal, controller.signal]);
      const retry = this.retry.delete(key);
      active.promise = this.execute(job, active, signal, retry).catch(error => {
        this.fatalError = new Error(`Worker state persistence failed. Stop and inspect state before restarting: ${controlled(error)}`);
        this.log('STATE_FAILED: no further reviews will start.');
      }).finally(() => this.active.delete(pr.number));
    }
  }
  private async execute(job: WorkerJob, active: Active, signal: AbortSignal, retry: boolean) {
    const reportPath = this.reportPath(job);
    let report: Report | null = null;
    try {
      try { report = parseReport(await readJson(reportPath, 16_000_000)); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw new Error('Saved report is invalid. Inspect it; automatic re-review is refused.');
      }
      if (report) {
        if (report.runId !== job.runId || report.toolVersion !== job.toolVersion || report.snapshot!.repository !== this.repository || report.snapshot!.pr !== job.pr.number || report.snapshot!.url !== job.pr.url
          || workerRevision(this.repository, { ...job.pr, headSha: report.snapshot!.headSha, baseSha: report.snapshot!.baseSha, title: report.snapshot!.title, body: report.snapshot!.body }, report.config, job.policy, job.toolVersion) !== job.key)
          throw new Error('Saved report snapshot or configuration does not match its worker job.');
      }
      if (!report && ['reviewed', 'publishing', 'previewed', 'blocked'].includes(job.status)) throw new Error('A saved report required for recovery is missing. No new model call was started.');
      if (report && (report.status === 'failed' || report.status === 'cancelled') && !retry) { job.status = report.status; job.detail = 'Saved review was unsuccessful. Explicit retry is required; no new model call was started.'; return; }
      if (!report || ['failed', 'cancelled'].includes(report.status)) {
        if (!retry && job.detail === 'Interrupted before a durable report was saved.') throw new Error(job.detail);
        if (retry) { job.runId = `${job.key.slice(0, 8)}-${randomUUID().slice(0, 8)}`; await this.persist(job); }
        const captureDirectory = join(this.root, 'capture', job.runId); await mkdir(captureDirectory, { recursive: true });
        let snapshot: Snapshot;
        try { snapshot = await this.dependencies.capture(job.pr, job.config, captureDirectory, signal); }
        finally { await rm(captureDirectory, { recursive: true, force: true }); }
        if (snapshot.headSha !== job.pr.headSha || snapshot.baseSha !== job.pr.baseSha || snapshot.repository !== this.repository || snapshot.pr !== job.pr.number || snapshot.url !== job.pr.url
          || snapshot.title !== job.pr.title || snapshot.body !== job.pr.body) throw new Error('Stale capture: PR changed before review started.');
        if (signal.aborted) throw new Error('Review cancelled.');
        this.log(`REVIEWING: PR ${job.pr.number}, head ${snapshot.headSha}, browser login only.`);
        report = await this.dependencies.review(snapshot, job.config, job.runId, join(this.root, 'runs'), signal,
          Object.fromEntries(Object.entries(this.pauses).map(([name, paused]) => [name, paused!.reason])));
        // The production reviewer saves to this exact known path; tests use the same durable boundary.
        await mkdir(join(this.root, 'runs', job.runId), { recursive: true }); await atomic(this.reportPath(job), report);
        for (const provider of report.providers) if (['failed', 'timed_out'].includes(provider.status) && provider.name !== 'fake') {
          this.pauses[provider.name] = { since: new Date().toISOString(), reason: 'Provider failed or timed out; inspect browser login and usage, then explicitly resume.' };
          this.log(`PROVIDER_PAUSED: ${provider.name}; no API fallback.`);
        }
        await atomic(join(this.root, 'paused-providers.json'), this.pauses);
      }
      if (signal.aborted || report.status === 'cancelled') { job.status = 'cancelled'; job.detail = 'Review cancelled; completed peer reports are retained.'; return; }
      if (report.status === 'failed') { job.status = 'failed'; job.detail = 'No usable reviewer result. Resume providers and explicitly retry after checking login/usage.'; return; }
      job.status = 'reviewed'; job.detail = `${report.status}: ${report.outcome}`; await this.persist(job);
      // Never cancel a publisher because of a new PR revision. Freshness is checked
      // by the existing publisher; SIGINT/deadline can still stop this process.
      active.phase = 'publish'; job.status = 'publishing'; await this.persist(job);
      const result = await this.dependencies.publish(this.reportPath(job), job.policy, this.root,
        AbortSignal.any([this.signal, AbortSignal.timeout(180_000)]), this.preview);
      job.status = this.preview ? 'previewed' : 'published'; job.detail = result.status; job.reviewUrl = result.url;
      this.log(`${job.status.toUpperCase()}: PR ${job.pr.number}; ${report.status}/${report.outcome}${result.url ? `; ${result.url}` : ''}.`);
    } catch (error) {
      job.detail = controlled(error);
      job.status = active.phase === 'publish' ? 'blocked' : signal.aborted ? 'cancelled' : /Stale capture/.test(job.detail) ? 'stale' : 'failed';
      this.log(`${job.status.toUpperCase()}: PR ${job.pr.number}; ${job.detail}`);
    } finally { await this.persist(job); }
  }
  async drain() { await Promise.all([...this.active.values()].map(a => a.promise)); if (this.fatalError) throw this.fatalError; }
}

export function workerRoot(stateDirectory: string, repository: string) { return resolve(stateDirectory, stableHash(repository).slice(0, 16)); }

export async function runWorker(options: { repository: string; configPath: string; stateDirectory: string; signal: AbortSignal;
  once?: boolean; pr?: number; preview?: boolean; retryFailed?: boolean; resumeProviders?: boolean }) {
  const repository = repositoryName.parse(options.repository), config = browserWorkerConfig(await readJson(options.configPath, 64_000));
  if (options.pr !== undefined) positive.parse(options.pr);
  const root = workerRoot(options.stateDirectory, repository); await mkdir(root, { recursive: true });
  let lock;
  try { lock = await open(join(root, 'worker.lock'), 'wx', 0o600); }
  catch { throw new Error('Worker lock exists or cannot be acquired. Use worker status; verify no worker/publisher is running before removing a stale lock.'); }
  try {
    await lock.writeFile(JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }));
    const [owner, repo] = repository.split('/') as [string, string];
    const token = await githubToken(options.signal);
    const client = new Octokit({ auth: token, request: { timeout: 30_000, fetch: globalThis.fetch }, retry: { enabled: false } });
    const metadata = (await client.rest.repos.get({ owner, repo, request: { signal: options.signal } })).data;
    if (metadata.full_name !== repository) throw new Error('Repository identity mismatch.');
    const dependencies: WorkerDependencies = {
      capture: (pr, config, directory, signal) => capturePr(pr.url, token, directory, config, signal),
      review: async (snapshot, config, runId, output, signal, pausedProviders) => (await review({ url: snapshot.url, capturedSnapshot: snapshot, config, runId, output, signal, pausedProviders })).report,
      publish: async (reportPath, policy, directory, signal, preview) => {
        const result = await publish({ reportPath, stateDirectory: join(directory, 'publications'), ...policy, signal, dryRun: preview });
        return { status: result.status, url: result.journal?.reviewUrl ?? null };
      },
    };
    const engine = new WorkerEngine(repository, metadata.default_branch, config, root, dependencies, options.signal, !!options.preview);
    await engine.initialize(options);
    console.log(`WORKER: ${repository}; browser login only; ${options.preview ? 'preview' : 'automatic COMMENT publication'}; poll ${config.pollSeconds}s; state ${root}.`);
    if (Object.keys(engine.pauses).length) console.log(`PAUSED_PROVIDERS: ${Object.keys(engine.pauses).join(', ')}; use --resume-providers after checking login and usage.`);
    let latest: WorkerPr[] = [];
    do {
      try {
        const list = options.pr
          ? [(await client.rest.pulls.get({ owner, repo, pull_number: options.pr, request: { signal: options.signal } })).data]
          : await client.paginate(client.rest.pulls.list, { owner, repo, state: 'open', per_page: 100, request: { signal: options.signal } });
        latest = list.map(pr => ({ number: pr.number, url: pr.html_url, title: pr.title.slice(0, 1000), body: (pr.body ?? '').slice(0, 20_000),
          headSha: pr.head.sha, baseSha: pr.base.sha, headRepository: pr.head.repo?.full_name ?? null, baseRef: pr.base.ref, draft: pr.draft ?? false, state: pr.state }));
        await engine.tick(latest);
      } catch (error) {
        if (options.signal.aborted) break;
        if (engine.fatalError) throw engine.fatalError;
        console.error(`POLL_FAILED: ${controlled(error)} No new review started from a failed listing.`);
        if (options.once) throw new Error('One-shot worker poll failed.');
      }
      if (options.once) { await engine.drain(); break; }
      try { await delay(config.pollSeconds * 1000, undefined, { signal: options.signal }); } catch { break; }
    } while (!options.signal.aborted);
    await engine.drain();
    const unfinished = latest.map(pr => engine.jobs.get(workerRevision(repository, pr, config.review, config.publication))).filter(job => job && !['published', 'previewed'].includes(job.status));
    return { unfinished: unfinished.length + engine.blockedPrs.size, pausedProviders: Object.keys(engine.pauses) };
  } finally { await lock.close(); await unlink(join(root, 'worker.lock')); }
}

export async function workerStatus(repository: string, stateDirectory: string) {
  const root = workerRoot(stateDirectory, repositoryName.parse(repository));
  let pauses: unknown = {}, jobs: unknown[] = [], lock: unknown = null;
  try { pauses = pauseSchema.parse(await readJson(join(root, 'paused-providers.json'), 64_000)); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  try { lock = z.strictObject({ pid: positive, startedAt: z.iso.datetime() }).parse(await readJson(join(root, 'worker.lock'), 64_000)); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  try { for (const file of await readdir(join(root, 'jobs'))) if (/^[a-f0-9]{64}\.json$/.test(file)) {
    const job = jobSchema.parse(await readJson(join(root, 'jobs', file), 128_000)); jobs.push({ pr: job.pr.number, headSha: job.pr.headSha, status: job.status, detail: job.detail, updatedAt: job.updatedAt, reviewUrl: job.reviewUrl });
  } } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  console.log(JSON.stringify({ repository, stateDirectory: root, lock, pausedProviders: pauses, jobs }, null, 2));
}
