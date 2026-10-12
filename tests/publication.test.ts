import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { configSchema, hash, snapshotSchema, VERSION, type Report, type Snapshot, type Reviewer } from '../src/contracts.js';
import { validateFindings } from '../src/diff.js';
import { normalize, type Finding } from '../src/normalize.js';
import { reviewPrompt } from '../src/provider.js';
import { PublicationApiError, type PublicationApi, type CurrentPr, type RemoteComment, type RemoteReview } from '../src/publication-api.js';
import { publicationPlan, type PlannedComment } from '../src/publication-plan.js';
import { executePublication } from '../src/publish.js';
import { parseReport } from '../src/report-input.js';

const fixture = snapshotSchema.parse(JSON.parse(await readFile(new URL('./fixtures/pr.json', import.meta.url), 'utf8')));
const defect: Finding = { title: 'Addition now subtracts', severity: 'high', path: 'math.ts', side: 'RIGHT', line: 1,
  description: 'The add export subtracts its operands.', trigger: 'Call add(2, 3) expecting addition.', impact: 'Returns -1 instead of the expected sum 5.', evidence: 'a - b' };
function reportFor(reviews: { name: Reviewer['name']; findings: Finding[] }[] = [{ name: 'claude', findings: [defect] }], snapshot: Snapshot = fixture): Report {
  const config = configSchema.parse({ reviewers: reviews.map(r => ({ name: r.name, model: 'test-model' })) });
  const contextHash = hash(snapshot), promptHash = hash(reviewPrompt(snapshot));
  const providers = reviews.map(r => {
    const rawResult = { summary: 'Found an arithmetic regression.', findings: r.findings, limitations: [] };
    const result = validateFindings(rawResult, snapshot);
    return { name: r.name, requestedModel: 'test-model', model: 'reported-model', version: 'test-cli',
      startedAt: '2026-10-12T00:00:00.000Z', finishedAt: '2026-10-12T00:00:01.000Z', durationMs: 1000,
      status: result.limitations.length || snapshot.exclusions.length ? 'partial' as const : 'complete' as const,
      contextHash, promptHash, rawResult, result, errors: [], usage: null };
  });
  const status = providers.some(p => p.status === 'partial') ? 'partial' : 'complete';
  const result = { summary: providers.map(p => `${p.name}: ${p.result.summary}`).join('\n'), findings: providers.flatMap(p => p.result.findings), limitations: providers.flatMap(p => p.result.limitations.map(l => `${p.name}: ${l}`)) };
  return { schemaVersion: 2, toolVersion: VERSION, runId: 'test-run', startedAt: '2026-10-12T00:00:00.000Z', finishedAt: '2026-10-12T00:00:01.000Z', durationMs: 1000,
    status, mode: 'live', outcome: result.findings.length ? 'findings' : status === 'complete' ? 'no_findings' : 'inconclusive',
    config, configHash: hash(config), contextHash, promptHash, snapshot, providers, provider: { name: 'multiple', version: null, model: null }, result, errors: [], usage: null };
}

class GitHubMemory implements PublicationApi {
  storedReviews: RemoteReview[] = []; storedComments: RemoteComment[] = [];
  creates = 0; updates: number[] = []; loseCreateResponse = false; loseWithoutCreating = false; loseUpdateResponse = false;
  mutateAfterCreate = false;
  pr: CurrentPr;
  constructor(snapshot: Snapshot) { this.pr = { state: 'open', draft: false, repository: snapshot.repository, pr: snapshot.pr, headSha: snapshot.headSha, baseSha: snapshot.baseSha }; }
  async identity() { return { id: 1, login: 'publisher' }; }
  async current() { return structuredClone(this.pr); }
  async reviews() { return structuredClone(this.storedReviews); }
  async comments() { return structuredClone(this.storedComments); }
  async create(body: string, comments: PlannedComment[], headSha: string) {
    this.creates++;
    if (this.loseWithoutCreating) throw new PublicationApiError(true, null);
    const review = { id: this.storedReviews.length + 100, body, userId: 1, commitId: headSha, state: 'COMMENTED', url: 'https://github.com/owner/repo/pull/1#pullrequestreview-100' };
    this.storedReviews.push(review);
    for (const c of comments) this.storedComments.push({ id: this.storedComments.length + 1000, userId: 1, body: c.body, originalCommitId: headSha,
      originalLine: c.line, originalSide: c.side, path: c.path, replyTo: null });
    if (this.mutateAfterCreate) this.pr.headSha = '9'.repeat(40);
    if (this.loseCreateResponse) throw new PublicationApiError(true, null);
    return review;
  }
  async update(id: number, body: string) {
    this.updates.push(id); const found = this.storedComments.find(c => c.id === id); assert.ok(found); found.body = body;
    if (this.loseUpdateResponse) throw new PublicationApiError(true, null);
  }
}

const policy = { allowPartial: true, maxComments: 20 };
async function setup(report: Report = reportFor()) {
  const root = await mkdtemp(join(tmpdir(), 'pr-publication-'));
  const api = new GitHubMemory(report.snapshot!);
  const options = { report, policy, api, stateDirectory: join(root, 'state'), outputDirectory: join(root, 'output'), signal: new AbortController().signal,
    capture: async () => structuredClone(report.snapshot!) };
  return { root, api, options };
}

test('strict report validation rejects tampered packets, provenance, aggregates, outcome and unsupported fields', () => {
  const original = reportFor(); assert.equal(parseReport(original), original);
  for (const edit of [
    (r: Report) => { r.snapshot!.files[0]!.after = 'forged'; },
    (r: Report) => { r.providers[0]!.contextHash = 'f'.repeat(64); },
    (r: Report) => { r.result!.findings = []; },
    (r: Report) => { r.mode = 'simulation'; },
    (r: Report) => { r.config.maxFiles = 1; },
  ]) { const changed = structuredClone(original); edit(changed); assert.throws(() => parseReport(changed)); }
  assert.throws(() => parseReport({ ...original, publishTo: 'another-repository' }));
});

test('dedup preserves provenance and severity without mutating model results; fuzzy claims never merge', () => {
  const report = reportFor([{ name: 'claude', findings: [defect] }, { name: 'grok', findings: [{ ...defect, title: 'Different wording', severity: 'critical' }] }]);
  const normalized = normalize(report);
  assert.equal(normalized.candidates.length, 1); assert.equal(normalized.candidates[0]?.origins.length, 2);
  assert.equal(normalized.candidates[0]?.finding.severity, 'critical'); assert.equal(report.providers[0]?.rawResult?.findings[0]?.severity, 'high');
  const different = normalize(reportFor([{ name: 'claude', findings: [defect] }, { name: 'grok', findings: [{ ...defect, trigger: 'Call add(2, -3) expecting subtraction instead.' }] }]));
  assert.equal(different.candidates.length, 2); assert.equal(different.conflictAnchors.length, 1);
  assert.ok(different.candidates.every(c => c.disposition === 'held'));
});

test('invalid locations and vague triggers are held in the summary without invented inline anchors', () => {
  const report = reportFor([{ name: 'claude', findings: [{ ...defect, line: 999 }, { ...defect, trigger: 'unknown' }] }]);
  const plan = publicationPlan(parseReport(report), policy);
  assert.equal(plan.comments.length, 0); assert.equal(plan.normalized.candidates.length, 2); assert.match(plan.summary, /Held candidates/);
  assert.match(plan.summary, /no inline location/); assert.match(plan.summary, /concrete trigger/);
});

test('identical wording at different file anchors remains separate root-cause candidates', () => {
  const snapshot = { ...fixture, totalChangedFiles: 2, files: [...fixture.files, { ...fixture.files[0]!, path: 'other.ts' }] };
  const report = reportFor([{ name: 'claude', findings: [defect, { ...defect, path: 'other.ts' }] }], snapshot);
  const plan = publicationPlan(parseReport(report), policy);
  assert.equal(plan.comments.length, 2); assert.notEqual(plan.comments[0]?.fingerprint, plan.comments[1]?.fingerprint);
});

test('dry-run re-fetches source and prepares payload but performs no GitHub writes', async () => {
  const { root, api, options } = await setup();
  try {
    const output = await executePublication({ ...options, dryRun: true });
    assert.equal(output.status, 'dry_run'); assert.equal(api.creates, 0); assert.deepEqual(api.updates, []);
    assert.match(await readFile(join(root, 'output/publication-preview.md'), 'utf8'), /Addition now subtracts/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('repeat publication and lost create responses reconcile the same review/comments exactly once', async () => {
  const { root, api, options } = await setup();
  try {
    api.loseCreateResponse = true;
    const first = await executePublication(options); const second = await executePublication(options);
    assert.equal(first.journal?.status, 'complete'); assert.equal(second.status, 'reconciled');
    assert.equal(api.creates, 1); assert.equal(api.storedReviews.length, 1); assert.equal(api.storedComments.length, 1);
    assert.equal(api.storedReviews[0]?.commitId, fixture.headSha);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('an unresolved create timeout never triggers another create request', async () => {
  const { root, api, options } = await setup();
  try {
    api.loseWithoutCreating = true;
    await assert.rejects(executePublication(options), /not confirmed/);
    await assert.rejects(executePublication(options), /No create retry/);
    assert.equal(api.creates, 1);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('stale head/base, closed/draft PRs, and forged source are rejected before writes', async () => {
  const { root, api, options } = await setup();
  try {
    for (const change of [{ headSha: 'a'.repeat(40) }, { baseSha: 'b'.repeat(40) }, { state: 'closed' as const }, { draft: true }]) {
      const original = { ...api.pr }; Object.assign(api.pr, change); await assert.rejects(executePublication(options)); api.pr = original;
    }
    await assert.rejects(executePublication({ ...options, capture: async () => ({ ...fixture, title: 'Different intent' }) }), /does not match/);
    assert.equal(api.creates, 0);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('refresh same-anchor findings updates only owned marked originals; replies/foreign/unrelated comments survive', async () => {
  const { root, api, options } = await setup();
  try {
    await executePublication(options);
    const original = api.storedComments[0]!;
    const reply = { ...original, id: 4001, replyTo: original.id, body: 'Human reply' };
    const foreign = { ...original, id: 4002, userId: 2 };
    const unrelated = { ...original, id: 4003, body: 'Unrelated human comment' };
    api.storedComments.push(reply, foreign, unrelated);
    const revised = reportFor([{ name: 'claude', findings: [{ ...defect, severity: 'critical' }] }]);
    await executePublication({ ...options, report: revised });
    assert.deepEqual(api.updates, [original.id]); assert.match(api.storedComments[0]!.body, /CRITICAL/);
    assert.equal(api.storedComments[1]?.body, reply.body); assert.equal(api.storedComments[2]?.body, foreign.body); assert.equal(api.storedComments[3]?.body, unrelated.body);
    assert.equal(api.storedComments.length, 4);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('lost update responses recover by reading the updated body; no second PATCH or POST', async () => {
  const { root, api, options } = await setup();
  try {
    await executePublication(options); api.loseUpdateResponse = true;
    const revised = { ...options, report: reportFor([{ name: 'claude', findings: [{ ...defect, severity: 'critical' }] }]) };
    await assert.rejects(executePublication(revised), /uncertain/);
    const recovered = await executePublication(revised);
    assert.equal(recovered.journal?.status, 'complete'); assert.equal(api.updates.length, 1); assert.equal(api.creates, 2);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('new heads preserve historical comments; a concurrent push leaves a superseded journal', async () => {
  const { root, api, options } = await setup();
  try {
    await executePublication(options);
    const previous = structuredClone(api.storedComments[0]);
    const nextSnapshot = { ...fixture, headSha: 'c'.repeat(40) };
    api.pr.headSha = nextSnapshot.headSha;
    const report = reportFor(undefined, nextSnapshot);
    await executePublication({ ...options, report, capture: async () => nextSnapshot });
    assert.equal(api.storedComments.length, 2); assert.deepEqual(api.storedComments[0], previous);
    api.mutateAfterCreate = true;
    const changed = reportFor([{ name: 'claude', findings: [{ ...defect, severity: 'critical' }] }], nextSnapshot);
    await assert.rejects(executePublication({ ...options, report: changed, capture: async () => nextSnapshot }), /Stale report/);
    assert.deepEqual(api.storedComments[0], previous);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('local PR lock serializes different reports and is released after completion', async () => {
  const { root, options } = await setup();
  let release!: () => void; let entered!: () => void;
  const ready = new Promise<void>(r => { entered = r; }); const gate = new Promise<void>(r => { release = r; });
  try {
    const first = executePublication({ ...options, capture: async () => { entered(); await gate; return fixture; } });
    await ready;
    await assert.rejects(executePublication(options), /holds this PR lock/);
    release(); await first;
    assert.equal((await executePublication(options)).status, 'reconciled');
  } finally { release(); await rm(root, { recursive: true, force: true }); }
});

test('partial publication requires opt-in and escapes model HTML/markers/mentions', () => {
  const report = reportFor([{ name: 'claude', findings: [{ ...defect, line: 99, title: '@someone <!-- fake -->' }] }]);
  assert.throws(() => publicationPlan(report, { ...policy, allowPartial: false }), /partial/);
  const plan = publicationPlan(report, policy);
  assert.ok(!plan.summary.includes('@someone')); assert.ok(plan.summary.includes('&lt;!-- fake --&gt;'));
});
