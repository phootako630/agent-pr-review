import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, writeFile, readFile, mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { configSchema, snapshotSchema, type ReviewResult } from '../src/contracts.js';
import { stableHash } from '../src/report-input.js';
import { evalPrompt, loadEvaluation, runEvaluation, evaluationWorksheet, scoreEvaluation, type EvalManifest } from '../src/evaluation.js';

const base = snapshotSchema.parse(JSON.parse(await readFile(new URL('./fixtures/pr.json', import.meta.url), 'utf8')));
const config = configSchema.parse({ reviewer: 'claude', model: 'fixture-model', auth: 'browser' });
const finding = { title: 'Wrong sum', severity: 'high' as const, path: 'math.ts', side: 'RIGHT' as const, line: 1,
  description: 'Subtracts instead of adding.', trigger: 'add(2, 1)', impact: 'Returns 1 instead of 3', evidence: 'a - b' };
const defect: ReviewResult = { summary: 'One candidate', findings: [finding], limitations: [] };
async function setup(count = 1) {
  const root = await mkdtemp(join(tmpdir(), 'eval-test-'));
  const cases: EvalManifest['cases'] = [];
  for (let n = 1; n <= count; n++) {
    const id = `case-${n}`, snapshot = { ...base, pr: n, url: `https://github.com/owner/repo/pull/${n}` };
    const labels = { caseId: id, snapshotHash: stableHash(snapshot), provenance: 'curated-fixture', completeness: 'known-issues-only',
      issues: [{ id: 'bug-1', description: 'SECRET_REFERENCE_DO_NOT_SEND', evidence: 'Demonstrated by add(2,1)' }], notes: '' };
    await writeFile(join(root, `${id}.json`), JSON.stringify(snapshot)); await writeFile(join(root, `${id}-labels.json`), JSON.stringify(labels));
    cases.push({ id, split: 'dev', group: id, language: 'TypeScript', source: { kind: 'synthetic', url: snapshot.url, revision: 'fixture', license: 'original' },
      snapshot: `${id}.json`, snapshotHash: stableHash(snapshot), labels: `${id}-labels.json`, labelsHash: stableHash(labels) });
  }
  const manifest = { schemaVersion: 1, datasetId: 'test', description: '', cases };
  const path = join(root, 'manifest.json'); await writeFile(path, JSON.stringify(manifest));
  const output = join(root, 'run');
  const options = { manifestPath: path, config, split: 'dev' as const, promptMode: 'rubric' as const, output, limit: count, maxCalls: count, signal: new AbortController().signal };
  return { root, path, manifest, output, options, cleanup: () => rm(root, { recursive: true, force: true }) };
}
function adapter(fn: (prompt: string) => Promise<ReviewResult> | ReviewResult) {
  return () => ({ probe: async () => 'fixture-cli', review: async (prompt: string) => ({ result: await fn(prompt), model: 'fixture-model', usage: null }) });
}

test('eval validates immutable inputs, answer hashes and disjoint groups', async () => {
  const f = await setup(2);
  try {
    assert.equal((await loadEvaluation(f.path, true)).manifest.cases.length, 2);
    f.manifest.cases[1]!.group = 'case-1'; f.manifest.cases[1]!.split = 'test';
    await writeFile(f.path, JSON.stringify(f.manifest));
    await assert.rejects(loadEvaluation(f.path), /cross dev\/test/);
    f.manifest.cases[1]!.group = 'case-2'; await writeFile(f.path, JSON.stringify(f.manifest));
    await writeFile(join(f.root, 'case-1-labels.json'), '{}');
    await assert.rejects(loadEvaluation(f.path, true));
    await writeFile(join(f.root, 'case-1.json'), JSON.stringify({ ...base, title: 'modified' }));
    await assert.rejects(loadEvaluation(f.path), /hash mismatch/);
  } finally { await f.cleanup(); }
});

test('inference never opens reference labels or sends them to an adapter', async () => {
  const f = await setup(); let calls = 0;
  try {
    await rm(join(f.root, 'case-1-labels.json'));
    const result = await runEvaluation({ ...f.options, adapter: adapter(prompt => {
      calls++; assert.ok(!prompt.includes('SECRET_REFERENCE')); assert.ok(prompt.includes('Challenge the claim')); return defect;
    }) });
    assert.equal(calls, 1); assert.equal(result.finished, 1); assert.equal(result.candidates, 1);
    assert.equal(result.scoring, 'pending-adjudication'); assert.equal(result.actualBilledCost, null);
    await assert.rejects(evaluationWorksheet(f.path, join(f.output, 'run.json'), join(f.root, 'score')));
  } finally { await f.cleanup(); }
});

test('explicit call budgets, browser authentication and fixed context checked before model calls', async () => {
  const f = await setup(2); let calls = 0;
  const noCall = adapter(() => { calls++; return defect; });
  try {
    await assert.rejects(runEvaluation({ ...f.options, maxCalls: 1, adapter: noCall }), /max-calls/);
    await assert.rejects(runEvaluation({ ...f.options, output: join(f.root, 'api'), config: { ...config, auth: 'api-key' }, adapter: noCall }), /browser/);
    const snapshot = JSON.parse(await readFile(join(f.root, 'case-1.json'), 'utf8'));
    snapshot.files[0].after += 'x'.repeat(2000);
    await writeFile(join(f.root, 'case-1.json'), JSON.stringify(snapshot)); f.manifest.cases[0]!.snapshotHash = stableHash(snapshot);
    await writeFile(f.path, JSON.stringify(f.manifest));
    await assert.rejects(runEvaluation({ ...f.options, config: { ...config, maxFileBytes: 128 }, adapter: noCall }), /fixed evaluation context/);
    assert.equal(calls, 0);
  } finally { await f.cleanup(); }
});

test('resume reuses finished cases and refuses changed strategy or interrupted inference', async () => {
  const f = await setup(); let calls = 0;
  try {
    const hook = adapter(() => { calls++; return defect; });
    await runEvaluation({ ...f.options, adapter: hook });
    await runEvaluation({ ...f.options, resume: true, adapter: hook });
    assert.equal(calls, 1);
    await assert.rejects(runEvaluation({ ...f.options, resume: true, promptMode: 'current', adapter: hook }), /identity differs/);
    await rm(join(f.output, 'case-1', 'result.json'));
    await assert.rejects(runEvaluation({ ...f.options, resume: true, adapter: hook }), /Interrupted model call/);
    assert.equal(calls, 1);
  } finally { await f.cleanup(); }
});

test('provider failure stops the batch and cannot silently continue on resume', async () => {
  const f = await setup(2); let calls = 0;
  try {
    const hook = adapter(() => { calls++; throw new Error('Provider allowance exhausted.'); });
    const result = await runEvaluation({ ...f.options, adapter: hook });
    assert.equal(calls, 1); assert.equal(result.failed, 1); assert.equal(result.finished, 1);
    await assert.rejects(runEvaluation({ ...f.options, resume: true, adapter: hook }), /Prior provider failure/);
    assert.equal(calls, 1);
  } finally { await f.cleanup(); }
});

test('pending judgements never produce misleading precision or recall', async () => {
  const f = await setup();
  try {
    await runEvaluation({ ...f.options, adapter: adapter(() => defect) });
    const scoreDir = join(f.root, 'score'), runPath = join(f.output, 'run.json');
    await evaluationWorksheet(f.path, runPath, scoreDir);
    const score = await scoreEvaluation(f.path, runPath, join(scoreDir, 'judgements.json'));
    assert.equal(score.status, 'incomplete'); assert.equal(score.actionablePrecision, null); assert.equal(score.knownIssueRecall, null);
    assert.equal(score.counts.unjudged, 1); assert.equal(score.counts.knownUnjudged, 1);
  } finally { await f.cleanup(); }
});

test('adjudication requires complete matching, accepts novel issues and rejects stale answers', async () => {
  const f = await setup();
  try {
    await runEvaluation({ ...f.options, adapter: adapter(() => defect) });
    const scoreDir = join(f.root, 'score'), runPath = join(f.output, 'run.json');
    const j = await evaluationWorksheet(f.path, runPath, scoreDir);
    j.evaluator = 'agent-assisted'; j.cases[0]!.candidates[0]!.verdict = 'true_positive';
    j.cases[0]!.candidates[0]!.matchedIssueIds = ['bug-1']; j.cases[0]!.candidates[0]!.rationale = 'add(2,1) proves subtraction.';
    j.cases[0]!.issues[0]!.verdict = 'found'; j.cases[0]!.issues[0]!.rationale = 'Candidate demonstrates the same trigger.';
    const jp = join(scoreDir, 'judgements.json'); await writeFile(jp, JSON.stringify(j));
    const score = await scoreEvaluation(f.path, runPath, jp);
    assert.equal(score.actionablePrecision, 1); assert.equal(score.knownIssueRecall, 1); assert.equal(score.evaluator, 'agent-assisted');
    j.cases[0]!.candidates[0]!.matchedIssueIds = []; j.cases[0]!.issues[0]!.verdict = 'missed';
    await writeFile(jp, JSON.stringify(j));
    assert.equal((await scoreEvaluation(f.path, runPath, jp)).actionablePrecision, 1); // Novel TP not automatically rejected.
    j.runHash = 'a'.repeat(64); await writeFile(jp, JSON.stringify(j));
    await assert.rejects(scoreEvaluation(f.path, runPath, jp), /stale/);
  } finally { await f.cleanup(); }
});

test('clean cases have undefined recall rather than a fabricated perfect score', async () => {
  const f = await setup();
  try {
    const labels = JSON.parse(await readFile(join(f.root, 'case-1-labels.json'), 'utf8')); labels.issues = [];
    await writeFile(join(f.root, 'case-1-labels.json'), JSON.stringify(labels)); f.manifest.cases[0]!.labelsHash = stableHash(labels); await writeFile(f.path, JSON.stringify(f.manifest));
    await runEvaluation({ ...f.options, adapter: adapter(() => ({ summary: 'No candidate', findings: [], limitations: [] })) });
    const scoreDir = join(f.root, 'score'), runPath = join(f.output, 'run.json'), j = await evaluationWorksheet(f.path, runPath, scoreDir);
    await writeFile(join(scoreDir, 'judgements.json'), JSON.stringify({ ...j, evaluator: 'human' }));
    const score = await scoreEvaluation(f.path, runPath, join(scoreDir, 'judgements.json'));
    assert.equal(score.actionablePrecision, null); assert.equal(score.knownIssueRecall, null);
  } finally { await f.cleanup(); }
});

test('evaluation prompt is separate from the production prompt', () => {
  assert.ok(!evalPrompt(base, 'current').includes('Review rubric evidence-v1'));
  assert.ok(evalPrompt(base, 'rubric').includes('Review rubric evidence-v1'));
});

test('project-authored corpus reproduces its seeded defects and correct counterexamples', async () => {
  // Execute only our authored tiny JS fixtures, never downloaded public source.
  const fixtures = JSON.parse(await readFile(new URL('../eval/synthetic.json', import.meta.url), 'utf8'));
  assert.equal(fixtures.length, 10);
  const modules = await Promise.all(fixtures.map(async (f: { before: string; after: string }) => ({
    before: await import('data:text/javascript,' + encodeURIComponent(f.before)),
    after: await import('data:text/javascript,' + encodeURIComponent(f.after)),
  })));
  const pages = async (page: number) => page === 1 ? { items: [1], next: 2 } : { items: [2], next: null };
  assert.deepEqual(await modules[0]!.after.collect(pages), [1]);
  assert.equal(modules[1]!.before.preview({ status: 'blocked', publicationAttempted: true }).publicationAttempted, true);
  assert.equal(modules[1]!.after.preview({ status: 'blocked', publicationAttempted: true }).publicationAttempted, false);
  assert.equal(modules[2]!.before.route('browser', { API_KEY: 'fixture' }, () => 'browser'), 'browser');
  assert.equal(modules[2]!.after.route('browser', { API_KEY: 'fixture' }, () => 'browser'), 'fixture');
  let cancelled = 0;
  const job = { phase: 'publishing', head: 'old', controller: { abort: () => cancelled++ } };
  modules[3]!.before.supersede(job, 'new'); assert.equal(cancelled, 0);
  modules[3]!.after.supersede(job, 'new'); assert.equal(cancelled, 1);
  for (const state of ['open', 'closed']) for (const draft of [false, true]) for (const fork of [false, true]) {
    const pr = { state, draft, fork }; assert.equal(modules[4]!.before.eligible(pr), modules[4]!.after.eligible(pr));
  }
  const a = { head: 'h', base: 'a' }, b = { head: 'h', base: 'b' }, sha = (s: string) => s;
  assert.notEqual(modules[5]!.before.key(a, 'p', sha), modules[5]!.before.key(b, 'p', sha));
  assert.equal(modules[5]!.after.key(a, 'p', sha), modules[5]!.after.key(b, 'p', sha));
  let calls = 0; const call = () => { calls++; return Promise.resolve({}); };
  await modules[6]!.before.review(true, call); assert.equal(calls, 0);
  await modules[6]!.after.review(true, call); assert.equal(calls, 1);
  assert.equal(modules[7]!.before.valid('safe\nbug', 'bug', 1), false);
  assert.equal(modules[7]!.after.valid('safe\nbug', 'bug', 1), true);
  assert.equal(modules[8]!.after.title('hello @user'), 'hello &#64;user');
  let released = 0;
  await assert.rejects(modules[9]!.after.run(async () => { throw new Error('fixture'); }, async () => released++));
  assert.equal(released, 1); assert.equal(await modules[9]!.after.run(async () => 42, async () => released++), 42);
  assert.equal(fixtures.filter((f: { issues: unknown[] }) => f.issues.length).length, 7);
});

test('uncertain findings and unavailable references do not masquerade as perfect overall metrics', async () => {
  const f = await setup();
  try {
    await runEvaluation({ ...f.options, adapter: adapter(() => defect) });
    const dir = join(f.root, 'score'), run = join(f.output, 'run.json'), j = await evaluationWorksheet(f.path, run, dir);
    j.evaluator = 'human'; j.cases[0]!.candidates[0]!.verdict = 'uncertain';
    j.cases[0]!.candidates[0]!.rationale = 'Missing caller contract.';
    j.cases[0]!.issues[0]!.verdict = 'not_assessable'; j.cases[0]!.issues[0]!.rationale = 'Reference requires unavailable caller contract.';
    const path = join(dir, 'judgements.json'); await writeFile(path, JSON.stringify(j));
    const score = await scoreEvaluation(f.path, run, path);
    assert.equal(score.actionablePrecision, null); assert.equal(score.knownIssueRecall, null);
    assert.equal(score.counts.uncertain, 1); assert.equal(score.counts.knownNotAssessable, 1);
  } finally { await f.cleanup(); }
});
