import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { configSchema, snapshotSchema } from '../src/contracts.js';
import { deliveryIdentity, eligibility, eventPr, missingCredentials, parseIntent, snapshotIdentity, statusContext } from '../src/actions.js';

const snapshot = snapshotSchema.parse(JSON.parse(await readFile(new URL('./fixtures/pr.json', import.meta.url), 'utf8')));
const repo = 'owner/repo';
const event = { repository: { full_name: repo, default_branch: 'main' }, action: 'synchronize',
  pull_request: { number: 42, head: { sha: '1'.repeat(40) } } };

test('ready/update event retains explicit PR head, never event merge SHA; manual input is numeric', () => {
  for (const action of ['opened', 'reopened', 'ready_for_review', 'synchronize'])
    assert.deepEqual(eventPr({ ...event, action }, 'pull_request_target', repo, 'main', 'refs/heads/main'), { pr: 42, expectedHead: '1'.repeat(40) });
  assert.deepEqual(eventPr({ ...event, inputs: { pr: '23' } }, 'workflow_dispatch', repo, 'main', 'refs/heads/main'), { pr: 23 });
  assert.throws(() => eventPr({ ...event, inputs: { pr: '23; echo secret' } }, 'workflow_dispatch', repo, 'main', 'refs/heads/main'));
});

test('comments, untrusted workflow refs, and cross-repository payloads cannot trigger privileged review', () => {
  assert.throws(() => eventPr(event, 'pull_request', repo, 'main', 'refs/pull/42/merge'));
  assert.throws(() => eventPr(event, 'workflow_dispatch', repo, 'main', 'refs/heads/feature'));
  assert.throws(() => eventPr(event, 'issue_comment', repo, 'main', 'refs/heads/main'));
  assert.throws(() => eventPr({ ...event, action: 'edited' }, 'pull_request_target', repo, 'main', 'refs/heads/main'));
  assert.throws(() => eventPr(event, 'pull_request_target', 'attacker/repo', 'main', 'refs/heads/main'));
});

test('drafts, forks, deleted fork repositories, closed PRs and alternate bases are explicit skips', () => {
  const current = { state: 'open', draft: false, headRepository: repo, baseRef: 'main' };
  assert.equal(eligibility(current, repo, 'main'), null);
  assert.equal(eligibility({ ...current, draft: true }, repo, 'main'), 'SKIPPED_DRAFT');
  assert.equal(eligibility({ ...current, headRepository: 'other/repo' }, repo, 'main'), 'SKIPPED_FORK');
  assert.equal(eligibility({ ...current, headRepository: null }, repo, 'main'), 'SKIPPED_FORK');
  assert.equal(eligibility({ ...current, state: 'closed' }, repo, 'main'), 'SKIPPED_CLOSED');
  assert.equal(eligibility({ ...current, baseRef: 'untrusted' }, repo, 'main'), 'SKIPPED_BASE_BRANCH');
});

test('same snapshot and policy deduplicate independently of report run timestamps; relevant changes invalidate delivery', () => {
  const config = configSchema.parse({ reviewer: 'codex', model: 'accessible-model' }), policy = { allowPartial: true, maxComments: 10 }, coordinator = '2'.repeat(40);
  const key = deliveryIdentity(snapshot, config, policy, coordinator);
  assert.equal(key, deliveryIdentity(structuredClone(snapshot), configSchema.parse(config), policy, coordinator));
  for (const changed of [
    deliveryIdentity({ ...snapshot, headSha: '3'.repeat(40) }, config, policy, coordinator),
    deliveryIdentity({ ...snapshot, baseSha: '3'.repeat(40) }, config, policy, coordinator),
    deliveryIdentity({ ...snapshot, body: 'New intent' }, config, policy, coordinator),
    deliveryIdentity(snapshot, { ...config, model: 'another-model' }, policy, coordinator),
    deliveryIdentity(snapshot, config, { ...policy, maxComments: 9 }, coordinator),
    deliveryIdentity(snapshot, config, policy, '4'.repeat(40)),
  ]) assert.notEqual(key, changed);
  // Uncertain intent must survive config/policy changes for the same source revision.
  assert.equal(statusContext(snapshot.pr, snapshotIdentity(snapshot)), statusContext(snapshot.pr, snapshotIdentity(structuredClone(snapshot))));
});

test('durable intent validates original run/attempt and refuses arbitrary URLs or invalid receipts', () => {
  const status = { state: 'pending', description: `apr1:${'a'.repeat(64)}:${'b'.repeat(64)}`, target_url: `https://github.com/${repo}/actions/runs/123/attempts/2` };
  assert.deepEqual(parseIntent(status, repo), { state: 'pending', publicationId: 'a'.repeat(64), deliveryKey: 'b'.repeat(64), runId: 123, attempt: 2 });
  for (const target_url of ['https://attacker.example/123', `https://github.com/${repo}/actions/runs/123/attempts/2?download=evil`, 'https://github.com/other/repo/actions/runs/123/attempts/2'])
    assert.throws(() => parseIntent({ ...status, target_url }, repo));
  assert.throws(() => parseIntent({ ...status, state: 'failure' }, repo));
  assert.throws(() => parseIntent({ ...status, description: 'malformed' }, repo));
});

test('hosted credential checks expose names only, never key values, and refuse browser/fake fallback', () => {
  const config = configSchema.parse({ reviewers: [
    { name: 'codex', model: 'model' }, { name: 'claude', model: 'model', auth: 'api-key' }, { name: 'grok', model: 'model', auth: 'api-key' },
  ] });
  assert.deepEqual(missingCredentials(config, {}), ['OPENAI_API_KEY', 'ANTHROPIC_API_KEY', 'XAI_API_KEY']);
  assert.deepEqual(missingCredentials(config, { OPENAI_API_KEY: 'secret', XAI_API_KEY: 'secret' }), ['ANTHROPIC_API_KEY']);
  assert.throws(() => missingCredentials(configSchema.parse({ reviewer: 'grok', model: 'model', auth: 'browser' }), {}));
  assert.throws(() => missingCredentials(configSchema.parse({ reviewer: 'fake' }), {}));
});
