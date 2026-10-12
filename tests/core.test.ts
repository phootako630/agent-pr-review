import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { configSchema, resultSchema, snapshotSchema } from '../src/contracts.js';
import { diffAnchors, parseRawDiff, validateFindings } from '../src/diff.js';
import { parsePrUrl } from '../src/github.js';
import { baseEnvironment, run } from '../src/process.js';
import { review } from '../src/review.js';
import { limitSnapshot } from '../src/snapshot.js';

const fixturePath = new URL('./fixtures/pr.json', import.meta.url);
const snapshot = snapshotSchema.parse(JSON.parse(await readFile(fixturePath, 'utf8')));

test('accept GitHub PR URLs, reject foreign hosts, credentials and invalid numbers', () => {
  assert.deepEqual(parsePrUrl('https://github.com/owner/repo/pull/123/files'.replace('/files', '')), { owner: 'owner', repo: 'repo', number: 123 });
  for (const url of ['https://github.com.evil/a/b/pull/1', 'http://github.com/a/b/pull/1', 'https://secret@github.com/a/b/pull/1', 'https://github.com/a/b/pull/0', 'https://github.com/a/b/pull/99999999999999999999', 'not-url']) assert.throws(() => parsePrUrl(url));
});

test('configuration rejects unknown fields and unsafe context paths', () => {
  for (const config of [{ timeoutSeconds: -1 }, { publish: true }, { contextFiles: ['../secret'] }, { contextFiles: ['C:/secret'] }, { maxFiles: 0 }]) assert.equal(configSchema.safeParse(config).success, false);
});

test('raw diff preserves rename paths containing spaces', () => {
  const changes = parseRawDiff(`:100644 100644 ${'a'.repeat(40)} ${'b'.repeat(40)} R095\0old name.ts\0new name.ts\0`);
  assert.equal(changes[0]?.previousPath, 'old name.ts');
  assert.equal(changes[0]?.path, 'new name.ts');
  assert.throws(() => parseRawDiff('invalid\0name\0'));
});

test('diff anchors handle deletion, addition, multiple hunks and no-newline markers', () => {
  const anchors = diffAnchors('--- a/a\n+++ b/a\n@@ -1,2 +1,2 @@\n keep\n-old\n+new\n\\ No newline at end of file\n@@ -10,0 +11,2 @@\n+x\n+y\n');
  assert.deepEqual([...anchors.LEFT], [1, 2]);
  assert.deepEqual([...anchors.RIGHT], [1, 2, 11, 12]);
  const deleted = diffAnchors('@@ -1 +0,0 @@\n-old\n');
  assert.deepEqual([...deleted.LEFT], [1]);
  assert.equal(deleted.RIGHT.size, 0);
});

test('findings require supported coordinates and exact code evidence', () => {
  const finding = { title: 'Wrong sum', severity: 'high', path: 'math.ts', side: 'RIGHT', line: 1, description: 'Subtracts instead of adding.', trigger: 'add(2, 1)', impact: 'Returns 1 instead of 3', evidence: 'a - b' };
  const result = resultSchema.parse({ summary: 'Found a regression', findings: [finding, { ...finding, line: 50 }, { ...finding, evidence: 'invented' }], limitations: [] });
  const validated = validateFindings(result, snapshot);
  assert.equal(validated.findings.length, 1);
  assert.equal(validated.limitations.length, 2);
  assert.equal(resultSchema.safeParse({ ...result, findings: [{ ...finding, path: '../secret' }] }).success, false);
});

test('evidence must overlap the cited source line, including multiline evidence', () => {
  const sample = { ...snapshot, files: [{ ...snapshot.files[0]!, after: 'const unrelated = 1;\nconst bug = true;\n', patch: '@@ -0,0 +1,2 @@\n+const unrelated = 1;\n+const bug = true;\n' }] };
  const finding = { title: 'Example', severity: 'high', path: 'math.ts', side: 'RIGHT', line: 1, description: 'Example', trigger: 'Example', impact: 'Example', evidence: 'const bug = true;' };
  const invalid = resultSchema.parse({ summary: 'Example', findings: [finding], limitations: [] });
  assert.equal(validateFindings(invalid, sample).findings.length, 0);
  const valid = resultSchema.parse({ ...invalid, findings: [{ ...finding, line: 2 }, { ...finding, line: 2, evidence: sample.files[0]!.after }] });
  assert.equal(validateFindings(valid, sample).findings.length, 2);
});

test('budget exclusions are explicit and never silently truncate a file', () => {
  const limited = limitSnapshot({ ...snapshot, files: [snapshot.files[0]!, { ...snapshot.files[0]!, path: 'extra.ts' }] }, configSchema.parse({ maxFiles: 1 }));
  assert.equal(limited.files.length, 1);
  assert.deepEqual(limited.exclusions, [{ path: 'extra.ts', reason: 'File count limit' }]);
  const big = limitSnapshot({ ...snapshot, files: [{ ...snapshot.files[0]!, after: 'x'.repeat(2000) }] }, configSchema.parse({ maxFileBytes: 128 }));
  assert.equal(big.files.length, 0);
  assert.equal(big.exclusions[0]?.reason, 'File size limit');
});

test('provider environment does not inherit GitHub tokens or arbitrary secrets', () => {
  process.env.REVIEW_TEST_SECRET = 'test-only';
  try { assert.equal(baseEnvironment().REVIEW_TEST_SECRET, undefined); assert.equal(baseEnvironment().GH_TOKEN, undefined); }
  finally { delete process.env.REVIEW_TEST_SECRET; }
});

test('subprocess cancellation and output caps terminate execution', async () => {
  await assert.rejects(run(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { signal: AbortSignal.timeout(200) }), /cancelled|deadline/);
  await assert.rejects(run(process.execPath, ['-e', 'process.stdout.write("x".repeat(10000))'], { maxBytes: 100 }), /output exceeded/);
  await assert.rejects(run('pr-review-nonexistent-executable', []), /Unable to start/);
});

test('offline fake run saves reports and never claims a clean live review', async () => {
  const output = await mkdtemp(join(tmpdir(), 'pr-review-test-'));
  try {
    const { directory, report } = await review({ fixture: fileURLToPath(fixturePath), output, config: configSchema.parse({ reviewer: 'fake', model: 'requested-only' }) });
    assert.equal(report.provider.model, null, 'Requested model must not substitute for a reported model');
    assert.equal(report.mode, 'simulation');
    assert.equal(report.outcome, 'inconclusive');
    assert.equal(report.status, 'partial');
    assert.match(await readFile(join(directory, 'report.md'), 'utf8'), /SIMULATION/);
    assert.equal(JSON.parse(await readFile(join(directory, 'report.json'), 'utf8')).contextHash, report.contextHash);
  } finally { await rm(output, { recursive: true, force: true }); }
});

test('cancelled runs still leave an honest report', async () => {
  const output = await mkdtemp(join(tmpdir(), 'pr-review-cancel-'));
  try {
    const { report } = await review({ fixture: fileURLToPath(fixturePath), output, config: configSchema.parse({ reviewer: 'fake' }), signal: AbortSignal.abort() });
    assert.equal(report.status, 'cancelled');
    assert.equal(report.outcome, 'inconclusive');
    assert.equal(report.result, null);
  } finally { await rm(output, { recursive: true, force: true }); }
});
