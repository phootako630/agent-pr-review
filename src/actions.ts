import { Octokit } from '@octokit/rest';
import { appendFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { z } from 'zod';
import { configSchema, hash, selectedReviewers, sha, snapshotSchema, VERSION, type Config, type Snapshot } from './contracts.js';
import { githubToken } from './github.js';
import { reviewPrompt } from './provider.js';
import { parseReport, same, stableHash } from './report-input.js';
import { publicationPlan, type Policy } from './publication-plan.js';
import { githubPublicationApi } from './publication-api.js';
import { executePublication } from './publish.js';
import { readJson, review } from './review.js';
import { capturePr } from './snapshot.js';

const digest = z.string().regex(/^[a-f0-9]{64}$/);
const positive = z.number().int().positive().safe();
const repository = z.string().regex(/^[\w.-]+\/[\w.-]+$/);
const policySchema = z.strictObject({ allowPartial: z.boolean(), maxComments: z.number().int().min(1).max(50) });
export const actionsConfigSchema = z.strictObject({ review: configSchema, publication: policySchema });
const sourceSchema = z.strictObject({ runId: positive, attempt: positive, coordinatorSha: sha });
const manifestSchema = z.strictObject({
  schemaVersion: z.literal(1), repository, pr: positive, source: sourceSchema,
  snapshotKey: digest, deliveryKey: digest, contextHash: digest,
  config: configSchema, policy: policySchema, toolVersion: z.string().max(100),
});
type Manifest = z.infer<typeof manifestSchema>;
export type Intent = { state: 'pending' | 'success'; publicationId: string; deliveryKey: string; runId: number; attempt: number };
const gateSchema = z.strictObject({ snapshot: snapshotSchema, manifest: manifestSchema, recovery: z.object({
  state: z.enum(['pending', 'success']), publicationId: digest, deliveryKey: digest, runId: positive, attempt: positive, coordinatorSha: sha,
}).nullable() });

export function snapshotIdentity(s: Snapshot): string {
  return stableHash({ repository: s.repository, pr: s.pr, url: s.url, headSha: s.headSha, baseSha: s.baseSha, mergeBaseSha: s.mergeBaseSha });
}
export function deliveryIdentity(snapshot: Snapshot, config: Config, policy: Policy, coordinatorSha: string): string {
  return stableHash({ version: 1, contextHash: hash(snapshot), promptHash: hash(reviewPrompt(snapshot)), config, policy, coordinatorSha, toolVersion: VERSION });
}
export function statusContext(pr: number, snapshotKey: string): string { return `agent-pr-review/pr-${pr}/${snapshotKey}`; }
export function parseIntent(input: { state: string; description: string | null; target_url: string | null }, repo: string): Intent {
  const match = /^apr1:([a-f0-9]{64}):([a-f0-9]{64})$/.exec(input.description ?? '');
  const prefix = `https://github.com/${repo}/actions/runs/`;
  const url = input.target_url ?? '';
  const run = url.startsWith(prefix) ? /^([1-9]\d*)\/attempts\/([1-9]\d*)$/.exec(url.slice(prefix.length)) : null;
  if (!match || !run || !['pending', 'success'].includes(input.state)) throw new Error('Durable publication status is invalid. Inspect its original run before retrying.');
  return { state: input.state as Intent['state'], publicationId: match[1]!, deliveryKey: match[2]!, runId: positive.parse(Number(run[1])), attempt: positive.parse(Number(run[2])) };
}
export function eventPr(event: unknown, name: string, repo: string, defaultBranch: string, ref: string): { pr: number; expectedHead?: string } {
  if (ref !== `refs/heads/${defaultBranch}`) throw new Error('Actions reviews must execute the default-branch workflow.');
  const input = z.object({ repository: z.object({ full_name: repository, default_branch: z.string() }) }).parse(event);
  if (input.repository.full_name !== repo || input.repository.default_branch !== defaultBranch) throw new Error('Event repository identity mismatch.');
  if (name === 'workflow_dispatch') return { pr: positive.parse(Number(z.object({ inputs: z.object({ pr: z.string().regex(/^[1-9]\d*$/) }) }).parse(event).inputs.pr)) };
  if (name !== 'pull_request_target') throw new Error('Unsupported review event; use pull_request_target or authenticated workflow_dispatch.');
  const data = z.object({ action: z.enum(['opened', 'reopened', 'ready_for_review', 'synchronize']),
    pull_request: z.object({ number: positive, head: z.object({ sha }) }) }).parse(event);
  return { pr: data.pull_request.number, expectedHead: data.pull_request.head.sha };
}
export function eligibility(pr: { state: string; draft: boolean; headRepository: string | null; baseRef: string }, repo: string, defaultBranch: string): string | null {
  if (pr.state !== 'open') return 'SKIPPED_CLOSED';
  if (pr.draft) return 'SKIPPED_DRAFT';
  if (pr.headRepository !== repo) return 'SKIPPED_FORK';
  if (pr.baseRef !== defaultBranch) return 'SKIPPED_BASE_BRANCH';
  return null;
}
export function missingCredentials(config: Config, env: NodeJS.ProcessEnv): string[] {
  return selectedReviewers(config).flatMap(r => {
    if (r.name === 'fake') throw new Error('Simulation is not allowed in automatic reviews.');
    if (r.auth === 'browser') throw new Error('Hosted Actions configuration requires API-key authentication.');
    const name = { codex: 'OPENAI_API_KEY', claude: 'ANTHROPIC_API_KEY', grok: 'XAI_API_KEY' }[r.name];
    return env[name] ? [] : [name];
  });
}

async function json(path: string, value: unknown) { await writeFile(path, JSON.stringify(value, null, 2) + '\n', { mode: 0o600 }); }
async function output(key: string, value: string | number) {
  if (!/^[a-z_]+$/.test(key) || /[\r\n]/.test(String(value))) throw new Error('Unsafe Actions output.');
  if (process.env.GITHUB_OUTPUT) await appendFile(process.env.GITHUB_OUTPUT, `${key}=${value}\n`);
}
async function log(message: string) {
  console.log(message);
  if (process.env.GITHUB_STEP_SUMMARY) await appendFile(process.env.GITHUB_STEP_SUMMARY, `${message}\n\n`);
}
async function runtime(signal: AbortSignal) {
  if (process.env.GITHUB_ACTIONS !== 'true' || !process.env.GITHUB_TOKEN) throw new Error('Actions commands require the standard GITHUB_TOKEN in a GitHub Actions job.');
  const repo = repository.parse(process.env.GITHUB_REPOSITORY);
  const [owner, name] = repo.split('/') as [string, string];
  const client = new Octokit({ auth: process.env.GITHUB_TOKEN, request: { signal, timeout: 30_000, fetch: globalThis.fetch }, retry: { enabled: false } });
  const target = { owner, repo: name };
  const metadata = (await client.rest.repos.get(target)).data;
  if (metadata.full_name !== repo) throw new Error('Repository identity mismatch.');
  return { repo, target, client, defaultBranch: metadata.default_branch };
}
async function trustedSource(rt: Awaited<ReturnType<typeof runtime>>, intent: Intent): Promise<string> {
  const run = (await rt.client.rest.actions.getWorkflowRunAttempt({ ...rt.target, run_id: intent.runId, attempt_number: intent.attempt })).data;
  const workflow = (await rt.client.rest.actions.getWorkflow({ ...rt.target, workflow_id: run.workflow_id })).data;
  if (workflow.path !== '.github/workflows/agent-review.yml' || !['pull_request_target', 'workflow_dispatch'].includes(run.event)
    || run.head_repository?.full_name !== rt.repo) throw new Error('Publication artifact did not originate from the trusted review workflow.');
  const comparison = (await rt.client.rest.repos.compareCommitsWithBasehead({ ...rt.target, basehead: `${sha.parse(run.head_sha)}...${rt.defaultBranch}` })).data;
  if (!['ahead', 'identical'].includes(comparison.status)) throw new Error('Artifact workflow revision is not in default-branch history.');
  return run.head_sha;
}
async function intentFor(rt: Awaited<ReturnType<typeof runtime>>, snapshot: Snapshot): Promise<Intent | null> {
  const statuses = await rt.client.paginate(rt.client.rest.repos.listCommitStatusesForRef, { ...rt.target, ref: snapshot.headSha, per_page: 100 });
  const bot = (await rt.client.rest.users.getByUsername({ username: 'github-actions[bot]' })).data;
  const found = statuses.find(s => s.context === statusContext(snapshot.pr, snapshotIdentity(snapshot)) && s.creator?.id === bot.id);
  return found ? parseIntent(found, rt.repo) : null;
}

export async function actionsGate(options: { configPath: string; outputDirectory: string; signal: AbortSignal }) {
  await output('eligible', 'false'); await output('recovery_run', 0); await output('recovery_attempt', 0);
  const rt = await runtime(options.signal);
  const parsed = eventPr(JSON.parse(await readFile(process.env.GITHUB_EVENT_PATH!, 'utf8')), process.env.GITHUB_EVENT_NAME!, rt.repo, rt.defaultBranch, process.env.GITHUB_REF!);
  await output('pr', parsed.pr);
  const current = (await rt.client.rest.pulls.get({ ...rt.target, pull_number: parsed.pr })).data;
  const skip = eligibility({ state: current.state, draft: current.draft ?? false, headRepository: current.head.repo?.full_name ?? null, baseRef: current.base.ref }, rt.repo, rt.defaultBranch);
  if (skip) { await log(skip); return; }
  if (process.env.AGENT_REVIEW_ENABLED !== 'true') { await log('SKIPPED_DISABLED: set AGENT_REVIEW_ENABLED=true after configuring model IDs and provider secrets.'); return; }
  if (parsed.expectedHead && current.head.sha !== parsed.expectedHead) { await log('STALE_EVENT: a newer head already exists.'); return; }
  const config = actionsConfigSchema.parse(await readJson(options.configPath, 64_000));
  selectedReviewers(config.review);
  if (selectedReviewers(config.review).some(r => r.model?.startsWith('CONFIGURE_'))) throw new Error('Configure accessible API model IDs in .github/agent-review.json on the default branch.');
  const directory = resolve(options.outputDirectory); await mkdir(directory, { recursive: true });
  const snapshot = await capturePr(current.html_url, process.env.GITHUB_TOKEN!, directory, config.review, options.signal);
  if (snapshot.headSha !== current.head.sha || snapshot.baseSha !== current.base.sha) { await log('STALE_CAPTURE: PR changed during capture.'); return; }
  const source = sourceSchema.parse({ runId: Number(process.env.GITHUB_RUN_ID), attempt: Number(process.env.GITHUB_RUN_ATTEMPT), coordinatorSha: process.env.GITHUB_SHA });
  const manifest: Manifest = { schemaVersion: 1, repository: rt.repo, pr: parsed.pr, source, snapshotKey: snapshotIdentity(snapshot),
    deliveryKey: deliveryIdentity(snapshot, config.review, config.publication, source.coordinatorSha), contextHash: hash(snapshot), config: config.review, policy: config.publication, toolVersion: VERSION };
  const prior = await intentFor(rt, snapshot);
  const recovery = prior ? { ...prior, coordinatorSha: await trustedSource(rt, prior) } : null;
  if (prior?.state === 'success' && prior.deliveryKey === manifest.deliveryKey) {
    const api = githubPublicationApi(process.env.GITHUB_TOKEN!, rt.target.owner, rt.target.repo, parsed.pr, options.signal, 'github-actions');
    const publisher = await api.identity();
    if (!(await api.reviews()).some(r => r.userId === publisher.id && r.commitId === snapshot.headSha && r.state === 'COMMENTED'
      && r.body.trimEnd().endsWith(`<!-- agent-pr-review:v1 run=${prior.publicationId} -->`))) throw new Error('Published status has no owned remote review; inspect deletion or delayed visibility.');
    await log('SKIPPED_DUPLICATE: this snapshot and review policy were published already.'); return;
  }
  await json(join(directory, 'gate.json'), { snapshot, manifest, recovery: recovery?.state === 'pending' ? recovery : null });
  if (recovery?.state === 'pending') { await output('recovery_run', recovery.runId); await output('recovery_attempt', recovery.attempt); await log('RECOVERY_REQUIRED: reuse the original report; no new review session or blind create retry.'); }
  await output('eligible', 'true');
  await log(`READY: PR ${parsed.pr}, head ${snapshot.headSha}, base ${snapshot.baseSha}.`);
}

export async function actionsReview(options: { packetDirectory: string; recoveredDirectory?: string; outputDirectory: string; signal: AbortSignal }) {
  const gate = gateSchema.parse(await readJson(join(options.packetDirectory, 'gate.json')));
  const directory = resolve(options.outputDirectory); await mkdir(directory, { recursive: true });
  if (gate.recovery) {
    if (!options.recoveredDirectory) throw new Error('Original report artifact is required for recovery. An expired or missing artifact requires operator inspection.');
    const manifest = manifestSchema.parse(await readJson(join(options.recoveredDirectory, 'manifest.json')));
    const report = parseReport(await readJson(join(options.recoveredDirectory, 'report.json'), 16_000_000));
    validateEnvelope(report, manifest);
    if (!same(manifest.source, { runId: gate.recovery.runId, attempt: gate.recovery.attempt, coordinatorSha: gate.recovery.coordinatorSha })
      || manifest.deliveryKey !== gate.recovery.deliveryKey || publicationPlan(report, manifest.policy).publicationId !== gate.recovery.publicationId
      || !same(report.snapshot, gate.snapshot)) throw new Error('Recovery artifact does not match durable intent or current source packet.');
    await json(join(directory, 'report.json'), report); await json(join(directory, 'manifest.json'), manifest);
    await log('RECOVERY_REPORT_READY: original immutable report and policy preserved.'); return;
  }
  const missing = missingCredentials(gate.manifest.config, process.env);
  if (missing.length) throw new Error(`MISSING_CREDENTIALS: configure repository Actions secrets: ${missing.join(', ')}. No model call or publication was made.`);
  const result = await review({ url: gate.snapshot.url, output: join(directory, 'temporary'), config: gate.manifest.config,
    capturedSnapshot: gate.snapshot, signal: options.signal, progress: message => console.error(message) });
  // Upload only these explicit data files. Never upload provider working homes.
  await json(join(directory, 'report.json'), result.report); await json(join(directory, 'manifest.json'), gate.manifest);
  await writeFile(join(directory, 'report.md'), await readFile(join(result.directory, 'report.md')));
  await writeFile(join(directory, 'normalized-findings.json'), await readFile(join(result.directory, 'normalized-findings.json')));
  await log(`REVIEW_${result.report.status.toUpperCase()}: ${result.report.outcome.toUpperCase()}.`);
  if (['failed', 'cancelled'].includes(result.report.status)) throw new Error('No usable completed report; publication is refused. Inspect retained diagnostics.');
}

export function validateEnvelope(input: unknown, manifestInput: unknown) {
  const report = parseReport(input), manifest = manifestSchema.parse(manifestInput);
  if (!report.snapshot || report.snapshot.repository !== manifest.repository || report.snapshot.pr !== manifest.pr
    || report.toolVersion !== manifest.toolVersion || !same(report.config, manifest.config)
    || hash(report.snapshot) !== manifest.contextHash || snapshotIdentity(report.snapshot) !== manifest.snapshotKey) throw new Error('Actions report identity, configuration, or source packet does not match its trusted envelope.');
  // Historical recovery may use the version which produced that report.
  const expected = stableHash({ version: 1, contextHash: hash(report.snapshot), promptHash: hash(reviewPrompt(report.snapshot)), config: manifest.config,
    policy: manifest.policy, coordinatorSha: manifest.source.coordinatorSha, toolVersion: manifest.toolVersion });
  if (expected !== manifest.deliveryKey) throw new Error('Actions delivery identity does not match the report envelope.');
  return { report, manifest };
}

export async function actionsPublish(options: { reportDirectory: string; outputDirectory: string; signal: AbortSignal; capture?: (directory: string) => Promise<Snapshot> }) {
  const { report, manifest } = validateEnvelope(await readJson(join(options.reportDirectory, 'report.json'), 16_000_000), await readJson(join(options.reportDirectory, 'manifest.json')));
  const rt = await runtime(options.signal);
  const event = eventPr(JSON.parse(await readFile(process.env.GITHUB_EVENT_PATH!, 'utf8')), process.env.GITHUB_EVENT_NAME!, rt.repo, rt.defaultBranch, process.env.GITHUB_REF!);
  if (event.pr !== manifest.pr) throw new Error('Report PR does not match the triggering event.');
  if (manifest.repository !== rt.repo) throw new Error('Cross-repository publication is refused.');
  if (await trustedSource(rt, { ...manifest.source, state: 'pending', publicationId: '', deliveryKey: '' }) !== manifest.source.coordinatorSha) throw new Error('Manifest coordinator revision does not match the source workflow run.');
  const snapshot = report.snapshot!;
  const current = (await rt.client.rest.pulls.get({ ...rt.target, pull_number: snapshot.pr })).data;
  const skip = eligibility({ state: current.state, draft: current.draft ?? false, headRepository: current.head.repo?.full_name ?? null, baseRef: current.base.ref }, rt.repo, rt.defaultBranch);
  if (skip) throw new Error(`${skip}: publication refused.`);
  const plan = publicationPlan(report, manifest.policy);
  const prior = await intentFor(rt, snapshot);
  const api = githubPublicationApi(process.env.GITHUB_TOKEN!, rt.target.owner, rt.target.repo, snapshot.pr, options.signal, 'github-actions');
  if (prior && prior.publicationId !== plan.publicationId) {
    if (prior.state === 'pending') throw new Error('Another publication owns this snapshot delivery. Recover its original report before posting.');
    if (prior.deliveryKey === manifest.deliveryKey) {
      await trustedSource(rt, prior);
      const publisher = await api.identity();
      if (!(await api.reviews()).some(r => r.userId === publisher.id && r.commitId === snapshot.headSha && r.state === 'COMMENTED'
        && r.body.trimEnd().endsWith(`<!-- agent-pr-review:v1 run=${prior.publicationId} -->`))) throw new Error('Duplicate-delivery receipt has no owned remote review.');
      await log('SKIPPED_DUPLICATE: another serialized publisher completed this delivery.'); return;
    }
  }
  const sourceUrl = `https://github.com/${rt.repo}/actions/runs/${manifest.source.runId}/attempts/${manifest.source.attempt}`;
  const status = async (state: 'pending' | 'success') => {
    // No retry: an unknown reservation response must stop before any PR write.
    await rt.client.rest.repos.createCommitStatus({ ...rt.target, sha: snapshot.headSha, context: statusContext(snapshot.pr, manifest.snapshotKey), state,
      description: `apr1:${plan.publicationId}:${manifest.deliveryKey}`, target_url: sourceUrl });
  };
  const result = await executePublication({ report, policy: manifest.policy, api, stateDirectory: join(options.outputDirectory, 'state'), outputDirectory: options.outputDirectory,
    signal: options.signal, reconcileOnly: prior?.publicationId === plan.publicationId, beforeCreate: async () => { await status('pending'); },
    capture: options.capture ?? (directory => capturePr(snapshot.url, process.env.GITHUB_TOKEN!, directory, manifest.config, options.signal)) });
  await status('success');
  await json(join(options.outputDirectory, 'receipt.json'), result.journal);
  await log(`${result.status.toUpperCase()}: ${result.plan.comments.length} inline comments. ${result.journal!.reviewUrl}`);
}

export async function dispatchReview(url: string, signal: AbortSignal) {
  const { parsePrUrl } = await import('./github.js'); const target = parsePrUrl(url);
  const client = new Octokit({ auth: await githubToken(signal), request: { signal, timeout: 30_000 }, retry: { enabled: false } });
  const repo = (await client.rest.repos.get({ owner: target.owner, repo: target.repo })).data;
  await client.rest.actions.createWorkflowDispatch({ owner: target.owner, repo: target.repo, workflow_id: 'agent-review.yml', ref: repo.default_branch, inputs: { pr: String(target.number) } });
  console.log('DISPATCHED: inspect the Actions run for eligibility, credential failures, review, and publication status.');
}
