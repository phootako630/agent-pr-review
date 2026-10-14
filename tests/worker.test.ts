import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, readFile, readdir, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { hash, snapshotSchema, selectedReviewers, VERSION, type Config, type Report, type Snapshot } from '../src/contracts.js';
import { reviewPrompt } from '../src/provider.js';
import { WorkerEngine, browserWorkerConfig, runWorker, workerRoot, workerRevision, type WorkerDependencies, type WorkerPr } from '../src/worker.js';

const snapshot = snapshotSchema.parse(JSON.parse(await readFile(new URL('./fixtures/pr.json', import.meta.url), 'utf8')));
const repository = snapshot.repository;
const pr: WorkerPr = { number: snapshot.pr, url: snapshot.url, title: snapshot.title, body: snapshot.body,
  headSha: snapshot.headSha, baseSha: snapshot.baseSha, headRepository: repository, baseRef: 'main', draft: false, state: 'open' };
const config = browserWorkerConfig({ review: { reviewer: 'codex', model: 'fixture', auth: 'browser' }, publication: { allowPartial: true, maxComments: 10 } });

function response(source: Snapshot, config: Config, runId: string, failed: string[] = []): Report {
  const contextHash = hash(source), promptHash = hash(reviewPrompt(source)), at = '2026-10-13T00:00:00.000Z';
  const providers = selectedReviewers(config).map(reviewer => {
    const result = failed.includes(reviewer.name) ? null : { summary: 'Synthetic protocol fixture.', findings: [], limitations: [] };
    return { name: reviewer.name, requestedModel: reviewer.model!, model: null, version: 'fixture-protocol', startedAt: at, finishedAt: at, durationMs: 0,
      status: result ? 'complete' as const : 'failed' as const, contextHash, promptHash, rawResult: result, result, errors: result ? [] : ['Provider usage allowance exhausted.'], usage: null };
  });
  const successful = providers.filter(p => p.result);
  const result = successful.length ? { summary: successful.map(p => `${p.name}: ${p.result!.summary}`).join('\n'), findings: [], limitations: [] } : null;
  const status = successful.length ? failed.length ? 'partial' : 'complete' : 'failed';
  return { schemaVersion: 2, toolVersion: VERSION, runId, startedAt: at, finishedAt: at, durationMs: 0,
    status, mode: 'live', outcome: status === 'complete' ? 'no_findings' : 'inconclusive', config, configHash: hash(config), contextHash, promptHash,
    provider: { name: providers.length === 1 ? providers[0]!.name : 'multiple', version: null, model: null }, providers, snapshot: source, result,
    errors: providers.flatMap(p => p.errors.map(e => `${p.name}: ${e}`)), usage: null };
}
async function setup(workerConfig = config) {
  const root = await mkdtemp(join(tmpdir(), 'apr-worker-'));
  const log: string[] = [], reviewed: string[] = [], published: { path: string; preview: boolean }[] = [];
  const dependencies: WorkerDependencies = {
    capture: async current => ({ ...snapshot, repository, pr: current.number, url: current.url, title: current.title, body: current.body, headSha: current.headSha, baseSha: current.baseSha }),
    review: async (source, config, runId) => { reviewed.push(source.headSha); return response(source, config, runId); },
    publish: async (path, _policy, _root, _signal, preview) => { published.push({ path, preview }); return { status: preview ? 'dry_run' : 'published', url: preview ? null : `${pr.url}#pullrequestreview-100` }; },
  };
  const engine = new WorkerEngine(repository, 'main', workerConfig, root, dependencies, new AbortController().signal, false, text => log.push(text));
  await engine.initialize();
  return { root, engine, dependencies, log, reviewed, published };
}

test('worker requires explicit browser authentication for every provider', () => {
  for (const review of [{ reviewer: 'codex', model: 'model' }, { reviewer: 'codex', model: 'model', auth: 'api-key' },
    { reviewers: [{ name: 'claude', model: 'model', auth: 'browser' }, { name: 'grok', model: 'model', auth: 'api-key' }] }, { reviewer: 'fake' }])
    assert.throws(() => browserWorkerConfig({ review }), /requires auth=browser/);
  assert.equal(workerRevision(repository, pr, config.review, config.publication), workerRevision(repository, structuredClone(pr), config.review, config.publication));
});

test('worker deduplicates polls/restarts and reviews a new head or base once', async () => {
  const { root, engine, dependencies, reviewed, published } = await setup();
  try {
    await engine.tick([pr]); await engine.drain(); await engine.tick([pr]); await engine.drain();
    const restarted = new WorkerEngine(repository, 'main', config, root, dependencies, new AbortController().signal, false, () => {});
    await restarted.initialize(); await restarted.tick([pr]); await restarted.drain();
    assert.equal(reviewed.length, 1); assert.equal(published.length, 1);
    const next = { ...pr, headSha: '3'.repeat(40) };
    await restarted.tick([next]); await restarted.drain();
    await restarted.tick([{ ...next, baseSha: '4'.repeat(40) }]); await restarted.drain();
    assert.equal(reviewed.length, 3); assert.equal(published.length, 3);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('draft/fork/closed/alternate-base guards skip; ready transition enqueues', async () => {
  const { root, engine, reviewed, log } = await setup();
  try {
    for (const current of [{ ...pr, draft: true }, { ...pr, headRepository: 'fork/repo' }, { ...pr, headRepository: null }, { ...pr, state: 'closed' }, { ...pr, baseRef: 'other' }]) {
      await engine.tick([current]); await engine.drain();
    }
    assert.equal(reviewed.length, 0); assert.ok(log.some(l => l.startsWith('SKIPPED_DRAFT'))); assert.ok(log.some(l => l.startsWith('SKIPPED_FORK')));
    await engine.tick([pr]); await engine.drain(); assert.equal(reviewed.length, 1);
    await assert.rejects(engine.tick([{ ...pr, url: 'https://github.com/attacker/repo/pull/1' }]), /identity mismatch/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('preview then publication reuses the original saved report without a second model call', async () => {
  const { root, dependencies, reviewed, published } = await setup();
  try {
    const preview = new WorkerEngine(repository, 'main', config, root, dependencies, new AbortController().signal, true, () => {});
    await preview.initialize(); await preview.tick([pr]); await preview.drain();
    const publish = new WorkerEngine(repository, 'main', config, root, dependencies, new AbortController().signal, false, () => {});
    await publish.initialize(); await publish.tick([pr]); await publish.drain();
    assert.equal(reviewed.length, 1); assert.deepEqual(published.map(p => p.preview), [true, false]);
    assert.equal(published[0]!.path, published[1]!.path);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('unknown publication outcome preserves original report; retry/config changes cannot start another model call', async () => {
  const { root, engine, dependencies, reviewed, published } = await setup();
  const original = dependencies.publish;
  try {
    dependencies.publish = async (...args) => { await original(...args); throw new Error('Outcome is uncertain; reconcile original report.'); };
    await engine.tick([pr]); await engine.drain(); assert.equal([...engine.jobs.values()][0]!.status, 'blocked');
    const changed = { ...config, publication: { ...config.publication, maxComments: 9 } };
    const changedEngine = new WorkerEngine(repository, 'main', changed, root, dependencies, new AbortController().signal, false, () => {});
    await changedEngine.initialize({ retryFailed: true }); await changedEngine.tick([pr]); await changedEngine.drain();
    assert.equal(reviewed.length, 1); assert.ok(changedEngine.blockedPrs.has(pr.number));
    const restarted = new WorkerEngine(repository, 'main', config, root, dependencies, new AbortController().signal, false, () => {});
    await restarted.initialize(); await restarted.tick([pr]); await restarted.drain(); assert.equal(published.length, 1);
    dependencies.publish = original;
    const retry = new WorkerEngine(repository, 'main', config, root, dependencies, new AbortController().signal, false, () => {});
    await retry.initialize({ retryFailed: true }); await retry.tick([pr]); await retry.drain();
    assert.equal(reviewed.length, 1); assert.equal(published.length, 2); assert.equal(published[0]!.path, published[1]!.path);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('recovery preview cannot clear unresolved publication or permit a changed-config model call', async () => {
  const { root, engine, dependencies, reviewed } = await setup(); const original = dependencies.publish;
  try {
    dependencies.publish = async () => { throw new Error('Unknown publication outcome.'); };
    await engine.tick([pr]); await engine.drain(); assert.equal([...engine.jobs.values()][0]!.status, 'blocked');
    dependencies.publish = original;
    const preview = new WorkerEngine(repository, 'main', config, root, dependencies, new AbortController().signal, true, () => {});
    await preview.initialize({ retryFailed: true }); await preview.tick([pr]); await preview.drain();
    assert.equal([...preview.jobs.values()][0]!.status, 'blocked');
    const changed = { ...config, publication: { ...config.publication, maxComments: 9 } };
    const changedEngine = new WorkerEngine(repository, 'main', changed, root, dependencies, new AbortController().signal, false, () => {});
    await changedEngine.initialize(); await changedEngine.tick([pr]); await changedEngine.drain();
    assert.equal(reviewed.length, 1); assert.ok(changedEngine.blockedPrs.has(pr.number));
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('failed provider pauses across PR revisions; peers publish partial results and explicit resume clears pause', async () => {
  const multiple = browserWorkerConfig({ review: { reviewers: [{ name: 'codex', model: 'fixture', auth: 'browser' }, { name: 'claude', model: 'fixture', auth: 'browser' }] } });
  const { root, engine, dependencies, reviewed, published } = await setup(multiple);
  const observed: unknown[] = [];
  try {
    dependencies.review = async (source, config, runId, _output, _signal, paused) => {
      reviewed.push(source.headSha); observed.push(paused); return response(source, config, runId, ['claude']);
    };
    await engine.tick([pr]); await engine.drain(); assert.ok(engine.pauses.claude); assert.equal(published.length, 1);
    await engine.tick([{ ...pr, headSha: '3'.repeat(40) }]); await engine.drain();
    assert.ok((observed[1] as any).claude); assert.equal(published.length, 2);
    const restarted = new WorkerEngine(repository, 'main', multiple, root, dependencies, new AbortController().signal, false, () => {});
    await restarted.initialize(); assert.ok(restarted.pauses.claude);
    await restarted.initialize({ resumeProviders: true }); assert.equal(restarted.pauses.claude, undefined);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('interrupted model call with no durable report waits for explicit retry', async () => {
  const { root, engine, dependencies, reviewed } = await setup();
  try {
    dependencies.review = async () => { throw new Error('Simulated interruption'); };
    await engine.tick([pr]); await engine.drain();
    const file = join(root, 'jobs', (await readdir(join(root, 'jobs')))[0]!);
    const interrupted = JSON.parse(await readFile(file, 'utf8')); interrupted.status = 'reviewing'; interrupted.detail = ''; await writeFile(file, JSON.stringify(interrupted));
    dependencies.review = async (source, config, runId) => { reviewed.push(source.headSha); return response(source, config, runId); };
    const restarted = new WorkerEngine(repository, 'main', config, root, dependencies, new AbortController().signal, false, () => {});
    await restarted.initialize(); await restarted.tick([pr]); await restarted.drain(); assert.equal(reviewed.length, 0);
    const retry = new WorkerEngine(repository, 'main', config, root, dependencies, new AbortController().signal, false, () => {});
    await retry.initialize({ retryFailed: true }); await retry.tick([pr]); await retry.drain(); assert.equal(reviewed.length, 1);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('new revision cancels only an active review and queues its replacement', { timeout: 10_000 }, async () => {
  const { root, engine, dependencies, published } = await setup();
  let entered!: () => void; const started = new Promise<void>(resolve => { entered = resolve; });
  try {
    dependencies.review = async (_source, _config, _runId, _output, signal) => {
      entered(); await new Promise<void>(resolve => signal.addEventListener('abort', () => resolve(), { once: true })); throw new Error('Review cancelled.');
    };
    await engine.tick([pr]); await started;
    const next = { ...pr, headSha: '3'.repeat(40) };
    await engine.tick([next]); await engine.drain(); assert.equal(published.length, 0); assert.equal([...engine.jobs.values()][0]!.status, 'cancelled');
    dependencies.review = async (source, config, runId) => response(source, config, runId);
    await engine.tick([next]); await engine.drain(); assert.equal(published.length, 1);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('new revision cannot cancel an active publisher; queue waits and freshness failure remains blocked', { timeout: 10_000 }, async () => {
  const { root, engine, dependencies } = await setup();
  let entered!: () => void, finish!: () => void;
  const started = new Promise<void>(r => { entered = r; }), gate = new Promise<void>(r => { finish = r; }); let signal!: AbortSignal;
  try {
    dependencies.publish = async (_path, _policy, _root, input) => { signal = input; entered(); await gate; throw new Error('Stale report: PR head changed.'); };
    await engine.tick([pr]); await started;
    await engine.tick([{ ...pr, headSha: '3'.repeat(40) }]); assert.equal(signal.aborted, false); assert.equal(engine.active.size, 1);
    finish(); await engine.drain(); assert.equal([...engine.jobs.values()][0]!.status, 'blocked');
  } finally { finish?.(); await rm(root, { recursive: true, force: true }); }
});

test('one-shot GitHub rate limit starts no review and releases the worker lock', async () => {
  const root = await mkdtemp(join(tmpdir(), 'apr-worker-poll-')), savedFetch = globalThis.fetch, savedToken = process.env.GH_TOKEN;
  try {
    const file = join(root, 'config.json'); await writeFile(file, JSON.stringify(config)); process.env.GH_TOKEN = 'fixture-token';
    globalThis.fetch = (async input => {
      const path = new URL(String(input)).pathname;
      if (path === `/repos/${repository}`) return new Response(JSON.stringify({ full_name: repository, default_branch: 'main' }), { headers: { 'content-type': 'application/json' } });
      if (path === `/repos/${repository}/pulls`) return new Response(JSON.stringify({ message: 'rate limited' }), { status: 429, headers: { 'content-type': 'application/json' } });
      throw new Error('Unexpected model/source call in rate-limit fixture.');
    }) as typeof fetch;
    await assert.rejects(runWorker({ repository, configPath: file, stateDirectory: root, signal: AbortSignal.timeout(10_000), once: true }), /poll failed/);
    const files = await readdir(workerRoot(root, repository)); assert.ok(!files.includes('worker.lock'));
    assert.equal((await readdir(join(workerRoot(root, repository), 'runs'))).length, 0);
  } finally {
    globalThis.fetch = savedFetch;
    if (savedToken === undefined) delete process.env.GH_TOKEN; else process.env.GH_TOKEN = savedToken;
    await rm(root, { recursive: true, force: true });
  }
});

test('a stale capture does not invoke a reviewer or publisher', async () => {
  const { root, engine, dependencies, reviewed, published } = await setup();
  try {
    const original = dependencies.capture;
    dependencies.capture = async (...args) => ({ ...await original(...args), headSha: 'f'.repeat(40) });
    await engine.tick([pr]); await engine.drain(); assert.equal(reviewed.length, 0); assert.equal(published.length, 0);
    assert.equal([...engine.jobs.values()][0]!.status, 'stale');
  } finally { await rm(root, { recursive: true, force: true }); }
});
