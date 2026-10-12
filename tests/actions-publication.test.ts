import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { actionsPublish, deliveryIdentity, snapshotIdentity, validateEnvelope } from '../src/actions.js';
import { configSchema, hash, snapshotSchema, VERSION, type Report } from '../src/contracts.js';
import { reviewPrompt } from '../src/provider.js';
import { publicationPlan } from '../src/publication-plan.js';

const snapshot = snapshotSchema.parse(JSON.parse(await readFile(new URL('./fixtures/pr.json', import.meta.url), 'utf8')));
const config = configSchema.parse({ reviewer: 'codex', model: 'fixture-model' });
const contextHash = hash(snapshot), promptHash = hash(reviewPrompt(snapshot)), coordinatorSha = '3'.repeat(40);
const policy = { allowPartial: true, maxComments: 10 };
const result = { summary: 'Synthetic complete response for transport testing.', findings: [], limitations: [] };
const at = '2026-10-12T00:00:00.000Z';
const report: Report = { schemaVersion: 2, toolVersion: VERSION, runId: 'transport-fixture', startedAt: at, finishedAt: at, durationMs: 0,
  status: 'complete', mode: 'live', outcome: 'no_findings', config, configHash: hash(config), contextHash, promptHash,
  provider: { name: 'codex', version: '0.162.1', model: null }, providers: [{ name: 'codex', version: '0.162.1', model: null, requestedModel: 'fixture-model',
    startedAt: at, finishedAt: at, durationMs: 0, status: 'complete', contextHash, promptHash, rawResult: result, result, errors: [], usage: null }],
  snapshot, result: { ...result, summary: `codex: ${result.summary}` }, errors: [], usage: null };
const manifest = { schemaVersion: 1, repository: snapshot.repository, pr: snapshot.pr, source: { runId: 123, attempt: 1, coordinatorSha },
  snapshotKey: snapshotIdentity(snapshot), deliveryKey: deliveryIdentity(snapshot, config, policy, coordinatorSha), contextHash, config, policy, toolVersion: VERSION };

test('Actions envelope rejects altered policy, repository, source and selection', () => {
  assert.doesNotThrow(() => validateEnvelope(report, manifest));
  for (const changed of [{ ...manifest, repository: 'attacker/repo' }, { ...manifest, policy: { ...policy, maxComments: 9 } },
    { ...manifest, contextHash: 'a'.repeat(64) }, { ...manifest, source: { ...manifest.source, coordinatorSha: '4'.repeat(40) } }])
    assert.throws(() => validateEnvelope(report, changed));
});

test('Actions transport reserves before POST; fresh runners reconcile; lost intent/receipt responses never duplicate', async () => {
  const root = await mkdtemp(join(tmpdir(), 'apr-actions-'));
  const savedEnv = { ...process.env }, savedFetch = globalThis.fetch;
  const statuses: any[] = [], reviews: any[] = [], calls: string[] = [];
  let failReservation = false, loseReservation = false, loseReceipt = false, loseCreate = false, hideReview = false, wrongWorkflow = false, wrongRevision = false, failRead = false;
  const eventPath = join(root, 'event.json');
  try {
    await writeFile(join(root, 'report.json'), JSON.stringify(report)); await writeFile(join(root, 'manifest.json'), JSON.stringify(manifest));
    await writeFile(eventPath, JSON.stringify({ repository: { full_name: snapshot.repository, default_branch: 'main' }, inputs: { pr: String(snapshot.pr) } }));
    Object.assign(process.env, { GITHUB_ACTIONS: 'true', GITHUB_TOKEN: 'fixture-token', GITHUB_REPOSITORY: snapshot.repository,
      GITHUB_EVENT_NAME: 'workflow_dispatch', GITHUB_EVENT_PATH: eventPath, GITHUB_REF: 'refs/heads/main' });
    delete process.env.GITHUB_STEP_SUMMARY; delete process.env.GITHUB_OUTPUT;
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(String(input)), path = decodeURIComponent(url.pathname), method = init?.method ?? 'GET';
      const body = init?.body ? JSON.parse(String(init.body)) : null;
      calls.push(`${method} ${path}`);
      const prefix = `/repos/${snapshot.repository}`;
      const respond = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json' } });
      const bot = { id: 41898282, login: 'github-actions[bot]', type: 'Bot' };
      if (path === prefix) return respond({ full_name: snapshot.repository, default_branch: 'main' });
      if (path === '/users/github-actions[bot]') return respond(bot);
      if (path === `${prefix}/actions/runs/123/attempts/1`) return respond({ workflow_id: 77, head_sha: wrongRevision ? '4'.repeat(40) : coordinatorSha, event: 'pull_request_target', head_repository: { full_name: snapshot.repository } });
      if (path === `${prefix}/actions/workflows/77`) return respond({ path: wrongWorkflow ? '.github/workflows/attacker.yml' : '.github/workflows/agent-review.yml' });
      if (path.startsWith(`${prefix}/compare/`)) return respond({ status: 'identical' });
      if (path === `${prefix}/pulls/1`) return respond({ number: 1, state: 'open', draft: false,
        head: { sha: snapshot.headSha, repo: { full_name: snapshot.repository } }, base: { sha: snapshot.baseSha, ref: 'main', repo: { full_name: snapshot.repository } } });
      if (path === `${prefix}/commits/${snapshot.headSha}/statuses`) {
        if (failRead) return respond({ message: 'rate limited' }, 403);
        return respond([...statuses].reverse());
      }
      if (path === `${prefix}/statuses/${snapshot.headSha}`) {
        if (failReservation && body.state === 'pending') return respond({ message: 'rate limited' }, 403);
        if (loseReceipt && body.state === 'success') throw new Error('Simulated unavailable status receipt');
        statuses.push({ ...body, creator: bot });
        if (loseReservation && body.state === 'pending') throw new Error('Simulated lost reservation response');
        return respond({ ...body, creator: bot }, 201);
      }
      if (path === `${prefix}/pulls/1/reviews` && method === 'GET') return respond(hideReview ? [] : reviews);
      if (path === `${prefix}/pulls/1/comments`) return respond([]);
      if (path === `${prefix}/pulls/1/reviews` && method === 'POST') {
        const review = { id: 101, user: bot, body: body.body, commit_id: body.commit_id, state: 'COMMENTED', html_url: `${snapshot.url}#pullrequestreview-101` };
        reviews.push(review);
        if (loseCreate) throw new Error('Simulated lost create response');
        return respond(review, 201);
      }
      throw new Error(`Unhandled fixture endpoint ${method} ${path}`);
    }) as typeof fetch;
    const invoke = (attempt: number) => actionsPublish({ reportDirectory: root, outputDirectory: join(root, `runner-${attempt}`), signal: AbortSignal.timeout(30_000), capture: async () => snapshot });
    failReservation = true;
    await assert.rejects(invoke(1)); assert.equal(reviews.length, 0); assert.equal(statuses.length, 0);
    failReservation = false; failRead = true;
    await assert.rejects(invoke(2)); assert.equal(reviews.length, 0); assert.equal(statuses.length, 0);
    failRead = false; wrongWorkflow = true;
    await assert.rejects(invoke(3), /trusted review workflow/); assert.equal(statuses.length, 0);
    wrongWorkflow = false; wrongRevision = true;
    await assert.rejects(invoke(4), /coordinator revision/); assert.equal(statuses.length, 0);
    wrongRevision = false; loseReservation = true;
    await assert.rejects(invoke(40)); assert.equal(reviews.length, 0); assert.equal(statuses.at(-1).state, 'pending');
    loseReservation = false;
    await assert.rejects(invoke(41), /No repeat create/); assert.equal(reviews.length, 0);
    // Reset this synthetic server to start a separate scenario. Product code has
    // no automatic intent-reset operation.
    statuses.length = 0;
    loseCreate = true; loseReceipt = true;
    await assert.rejects(invoke(5)); assert.equal(reviews.length, 1);
    assert.ok(calls.indexOf(`POST /repos/${snapshot.repository}/statuses/${snapshot.headSha}`) < calls.indexOf(`POST /repos/${snapshot.repository}/pulls/1/reviews`));
    // Fresh directories have no local journal. The durable reservation is the guard.
    loseReceipt = false; hideReview = true;
    await assert.rejects(invoke(6), /No repeat create/); assert.equal(reviews.length, 1);
    await writeFile(join(root, 'report.json'), JSON.stringify({ ...report, runId: 'changed-report-during-uncertainty' }));
    await assert.rejects(invoke(60), /Recover its original report/); assert.equal(reviews.length, 1);
    await writeFile(join(root, 'report.json'), JSON.stringify(report));
    const changedPolicy = { ...policy, maxComments: 9 };
    await writeFile(join(root, 'manifest.json'), JSON.stringify({ ...manifest, policy: changedPolicy, deliveryKey: deliveryIdentity(snapshot, config, changedPolicy, coordinatorSha) }));
    await assert.rejects(invoke(61), /Recover its original report/); assert.equal(reviews.length, 1);
    await writeFile(join(root, 'manifest.json'), JSON.stringify(manifest));
    hideReview = false;
    await invoke(7); assert.equal(reviews.length, 1); assert.equal(statuses.at(-1).state, 'success');
    await invoke(8); assert.equal(reviews.length, 1);
    // A duplicate review run changes report timestamps/ID but retains delivery identity.
    await writeFile(join(root, 'report.json'), JSON.stringify({ ...report, runId: 'repeat-transport-fixture' }));
    await invoke(9); assert.equal(reviews.length, 1);
    assert.equal(calls.filter(c => c === `POST /repos/${snapshot.repository}/pulls/1/reviews`).length, 1);
  } finally {
    globalThis.fetch = savedFetch;
    for (const key of Object.keys(process.env)) if (!(key in savedEnv)) delete process.env[key];
    Object.assign(process.env, savedEnv); await rm(root, { recursive: true, force: true });
  }
});
