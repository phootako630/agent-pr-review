import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { configSchema, snapshotSchema, type ReviewResult } from '../src/contracts.js';
import { stableHash } from '../src/report-input.js';
import { evalCandidates, evaluationWorksheet, runEvaluation } from '../src/evaluation.js';
import { compareVerification, effectiveDecisions, resolveSourceContext, verificationPrompt, verificationResponseSchema, verifyEvaluation, type VerificationResponse, type VerifierClient } from '../src/verification.js';
import { parseClaudeOutput, parseGrokOutput } from '../src/native-providers.js';

const base = snapshotSchema.parse(JSON.parse(await readFile(new URL('./fixtures/pr.json', import.meta.url), 'utf8')));
const config = configSchema.parse({ reviewer: 'codex', model: 'test-model', auth: 'browser', timeoutSeconds: 10, providerTimeoutSeconds: 5 });
const finding = { title: 'Subtracts rather than adds', severity: 'high' as const, path: 'math.ts', side: 'RIGHT' as const, line: 1,
  description: 'Addition is replaced with subtraction.', trigger: 'add(2,1)', impact: 'Returns 1 rather than 3.', evidence: 'a - b' };
const decoy = { ...finding, title: 'Always NaN', description: 'This always returns NaN.', trigger: 'Any numeric arguments', impact: 'NaN instead of a number.' };
async function setup(count = 1, empty = false) {
  const root = await mkdtemp(join(tmpdir(), 'verification-test-')), cases = [];
  for (let n = 1; n <= count; n++) {
    const id = `case-${n}`, snapshot = { ...base, pr: n, url: `https://github.com/owner/repo/pull/${n}` };
    const label = { caseId: id, snapshotHash: stableHash(snapshot), provenance: 'curated-fixture', completeness: 'known-issues-only',
      issues: [{ id: 'issue-1', description: 'SECRET_REFERENCE_NEVER_SEND', evidence: 'add(2,1) returns 1.' }], notes: '' };
    await writeFile(join(root, `${id}.json`), JSON.stringify(snapshot)); await writeFile(join(root, `${id}-labels.json`), JSON.stringify(label));
    cases.push({ id, split: 'dev', group: id, language: 'TypeScript', source: { kind: 'synthetic', url: snapshot.url, revision: 'test', license: 'original' },
      snapshot: `${id}.json`, snapshotHash: stableHash(snapshot), labels: `${id}-labels.json`, labelsHash: stableHash(label) });
  }
  const manifestPath = join(root, 'manifest.json'); await writeFile(manifestPath, JSON.stringify({ schemaVersion: 1, datasetId: 'test', description: '', cases }));
  const output = join(root, 'baseline'), result: ReviewResult = { summary: 'Fixture review', findings: empty ? [] : [finding, decoy], limitations: [] };
  const baseline = await runEvaluation({ manifestPath, config, split: 'dev', promptMode: 'rubric', output, limit: count, maxCalls: count, signal: new AbortController().signal,
    adapter: () => ({ probe: async () => 'test-cli', review: async () => ({ result, model: 'test-model', usage: null }) }) });
  return { root, baseline, manifestPath, runPath: join(output, 'run.json'), options: { manifestPath, runPath: join(output, 'run.json'), config,
    output: join(root, 'verified'), maxCalls: count * 2, signal: new AbortController().signal }, cleanup: () => rm(root, { recursive: true, force: true }) };
}
function packet(prompt: string) {
  return JSON.parse(prompt.split('BEGIN_UNTRUSTED_VERIFICATION_PACKET\n')[1]!.split('\nEND_UNTRUSTED_VERIFICATION_PACKET')[0]!);
}
function decisions(prompt: string, verdict: 'supported' | 'rejected' | 'uncertain' = 'supported'): VerificationResponse {
  const p = packet(prompt);
  return { requests: [], limitations: [], decisions: p.candidates.map((c: { id: string }) => ({ candidateId: c.id, verdict,
    reason: 'A concrete numeric example establishes or refutes this candidate.', evidence: [{ path: 'math.ts', side: 'RIGHT', line: 1, quote: 'a - b' }] })) };
}
function client(fn: (prompt: string) => VerificationResponse | Promise<VerificationResponse>): VerifierClient {
  return { probe: async () => 'test-cli', invoke: async p => ({ result: await fn(p), model: 'test-model', usage: null }) };
}
const request = { path: 'math.ts', side: 'RIGHT' as const, startLine: 1, endLine: 3, reason: 'Check the function contract.' };

test('verifier sessions never open labels and preserve exact candidate identities', async () => {
  const f = await setup(); let calls = 0;
  try {
    await rm(join(f.root, 'case-1-labels.json'));
    const result = await verifyEvaluation({ ...f.options, client: client(p => {
      calls++; assert.ok(!p.includes('SECRET_REFERENCE')); assert.equal(packet(p).candidates.length, 2); return decisions(p);
    }) });
    assert.equal(calls, 1); assert.equal(result.calls, 1); assert.equal(result.results[0]!.status, 'verified');
    assert.equal(result.results[0]!.decisions.length, 2);
    assert.ok(!JSON.stringify(result).includes('SECRET_REFERENCE'));
  } finally { await f.cleanup(); }
});

test('one source request round binds exact revision and evidence to final decisions', async () => {
  const f = await setup(); let calls = 0, reads = 0;
  try {
    const result = await verifyEvaluation({ ...f.options, client: client(p => {
      calls++;
      if (calls === 1) return { requests: [request], decisions: [], limitations: [] };
      assert.ok(p.includes('Phase: final')); assert.equal(packet(p).contexts[0].revision, base.headSha); return decisions(p);
    }), contextResolver: async (snapshot, requests, isPublic, signal) => {
      reads++; assert.equal(isPublic, false); return resolveSourceContext(snapshot, requests, false, signal);
    } });
    assert.equal(calls, 2); assert.equal(reads, 1); assert.equal(result.calls, 2);
    assert.equal(result.results[0]!.contexts[0]!.status, 'available');
    assert.equal(result.results[0]!.status, 'verified');
  } finally { await f.cleanup(); }
});

test('missing source citations downgrade rejection to uncertainty, not silent deletion', () => {
  const response: VerificationResponse = { requests: [], limitations: [], decisions: [{ candidateId: 'a'.repeat(64), verdict: 'rejected', reason: 'Missing caller.', evidence: [] }] };
  assert.equal(effectiveDecisions(response, base, [])[0]!.verdict, 'uncertain');
  response.decisions[0]!.evidence = [{ path: 'secret.ts', side: 'RIGHT', line: 1, quote: 'nonexistent guard' }];
  assert.equal(effectiveDecisions(response, base, [])[0]!.verdict, 'uncertain');
});

test('numbered packets preserve original source coordinates through omitted windows', () => {
  const snapshot = { ...base, files: [{ ...base.files[0]!, after: '\n'.repeat(99) + 'const guarded = true;\n' }] };
  const p = packet(verificationPrompt(snapshot, [], [], false));
  assert.deepEqual(p.snapshot.files[0].after, [{ line: 100, text: 'const guarded = true;' }]);
  const response: VerificationResponse = { requests: [], limitations: [], decisions: [{ candidateId: 'a'.repeat(64), verdict: 'supported', reason: 'Source proof.',
    evidence: [{ path: 'math.ts', side: 'RIGHT', line: 99, quote: 'const guarded = true;' }] }] };
  assert.equal(effectiveDecisions(response, snapshot, [])[0]!.verdict, 'uncertain');
  response.decisions[0]!.evidence[0]!.line = 100;
  assert.equal(effectiveDecisions(response, snapshot, [])[0]!.verdict, 'supported');
});

test('a second context round fails conservatively and counts both invocations', async () => {
  const f = await setup(); let calls = 0;
  try {
    const result = await verifyEvaluation({ ...f.options, client: client(() => { calls++; return { requests: [request], decisions: [], limitations: [] }; }) });
    assert.equal(calls, 2); assert.equal(result.calls, 2); assert.equal(result.results[0]!.status, 'failed');
    assert.ok(result.results[0]!.decisions.every(d => d.verdict === 'uncertain'));
  } finally { await f.cleanup(); }
});

test('call budget and browser-only selection are enforced before any invocation', async () => {
  const f = await setup(); let calls = 0;
  try {
    const hook = client(p => { calls++; return decisions(p); });
    await assert.rejects(verifyEvaluation({ ...f.options, maxCalls: 1, client: hook }), /max-calls/);
    await assert.rejects(verifyEvaluation({ ...f.options, config: { ...config, auth: 'api-key' }, output: join(f.root, 'api'), client: hook }), /browser/);
    assert.equal(calls, 0);
  } finally { await f.cleanup(); }
});

test('failure stops remaining cases, redacts exception data and forbids automatic continuation', async () => {
  const f = await setup(2); let calls = 0;
  try {
    const hook = client(() => { calls++; throw new Error('PRIVATE_PROVIDER_OUTPUT'); });
    const result = await verifyEvaluation({ ...f.options, client: hook });
    assert.equal(calls, 1); assert.equal(result.calls, 1); assert.equal(result.finished, 1);
    assert.ok(!JSON.stringify(result).includes('PRIVATE_PROVIDER_OUTPUT'));
    await assert.rejects(verifyEvaluation({ ...f.options, client: hook, resume: true }), /Previous verification failed/);
    assert.equal(calls, 1);
  } finally { await f.cleanup(); }
});

test('resume reuses valid results; changed config and interrupted calls never silently rerun', async () => {
  const f = await setup(); let calls = 0;
  try {
    const hook = client(p => { calls++; return decisions(p); });
    await verifyEvaluation({ ...f.options, client: hook });
    const repeated = await verifyEvaluation({ ...f.options, client: hook, resume: true });
    assert.equal(calls, 1); assert.equal(repeated.newInvocations, 0);
    await assert.rejects(verifyEvaluation({ ...f.options, client: hook, resume: true, config: { ...config, model: 'other' } }), /identity differs/);
    await rm(join(f.options.output, 'case-1', 'result.json'));
    await assert.rejects(verifyEvaluation({ ...f.options, client: hook, resume: true }), /Interrupted/);
    assert.equal(calls, 1);
  } finally { await f.cleanup(); }
});

test('immutable source requests cannot read local labels or escape path/line budgets', async () => {
  const signal = new AbortController().signal;
  const missing = await resolveSourceContext(base, [{ ...request, path: 'labels/case-1.json' }], false, signal);
  assert.equal(missing[0]!.status, 'unavailable'); assert.equal(missing[0]!.text, null);
  await assert.rejects(resolveSourceContext(base, [{ ...request, path: '../labels.json' }], false, signal));
  await assert.rejects(resolveSourceContext(base, [{ ...request, endLine: 201 }], false, signal));
  const previous = globalThis.fetch; let captured = '';
  globalThis.fetch = async (url, options) => { captured = String(url); assert.equal(options?.redirect, 'error'); assert.equal(options?.headers, undefined); return new Response('one\ntwo\nthree'); };
  try {
    const result = await resolveSourceContext(base, [{ ...request, side: 'LEFT', startLine: 2 }], true, signal);
    assert.ok(captured.includes('/' + base.mergeBaseSha + '/math.ts')); assert.equal(result[0]!.text, 'two\nthree');
    globalThis.fetch = async () => new Response('x'.repeat(1_000_001));
    assert.equal((await resolveSourceContext(base, [request], true, signal))[0]!.status, 'unavailable');
    let attempts = 0;
    globalThis.fetch = async url => { attempts++; captured = String(url); return attempts === 1 ? new Response('', { status: 404 }) : new Response('one\ntwo'); };
    assert.equal((await resolveSourceContext(base, [request], true, signal))[0]!.status, 'available');
    assert.equal(attempts, 2); assert.ok(captured.includes('/review-bench/' + base.repository.replace('/', '_') + '/' + base.headSha + '/'));
    globalThis.fetch = async () => new Response(('x'.repeat(300) + '\n').repeat(200));
    assert.equal((await resolveSourceContext(base, [{ ...request, endLine: 200 }], true, signal))[0]!.status, 'unavailable');
  } finally { globalThis.fetch = previous; }
});

test('LEFT citations and requests honor destination-path findings on renamed files', async () => {
  const snapshot = { ...base, files: [{ ...base.files[0]!, path: 'new.ts', previousPath: 'old.ts', before: 'const original = true;\n' }] };
  const response: VerificationResponse = { requests: [], limitations: [], decisions: [{ candidateId: 'a'.repeat(64), verdict: 'rejected', reason: 'Before-side counterevidence.',
    evidence: [{ path: 'new.ts', side: 'LEFT', line: 1, quote: 'const original = true;' }] }] };
  assert.equal(effectiveDecisions(response, snapshot, [])[0]!.verdict, 'rejected');
  const previous = globalThis.fetch; let captured = '';
  globalThis.fetch = async url => { captured = String(url); return new Response('const original = true;\n'); };
  try {
    const result = await resolveSourceContext(snapshot, [{ ...request, path: 'new.ts', side: 'LEFT' }], true, new AbortController().signal);
    assert.ok(captured.endsWith('/' + base.mergeBaseSha + '/old.ts')); assert.equal(result[0]!.request.path, 'new.ts');
    assert.equal(result[0]!.status, 'available');
    response.decisions[0]!.evidence[0]!.path = 'old.ts';
    const windowed = { ...snapshot, files: [{ ...snapshot.files[0]!, before: '\n' }] };
    assert.equal(effectiveDecisions(response, windowed, result)[0]!.verdict, 'rejected');
  } finally { globalThis.fetch = previous; }
});

test('comparison exposes rejection of a known true positive and does not treat it as success', async () => {
  const f = await setup();
  try {
    await verifyEvaluation({ ...f.options, client: client(p => decisions(p, 'rejected')) });
    const dir = join(f.root, 'adjudication'), j = await evaluationWorksheet(f.manifestPath, f.runPath, dir);
    j.evaluator = 'agent-assisted';
    const candidates = evalCandidates(f.baseline.results[0]!);
    for (const v of j.cases[0]!.candidates) {
      const candidate = candidates.find(c => c.id === v.candidateId)!;
      v.verdict = candidate.finding.title === finding.title ? 'true_positive' : 'false_positive';
      v.rationale = 'Direct numeric example: 2-1=1, not 3 or NaN.';
      if (v.verdict === 'true_positive') v.matchedIssueIds = ['issue-1'];
    }
    j.cases[0]!.issues[0]!.verdict = 'found'; j.cases[0]!.issues[0]!.rationale = 'Same numeric trigger.';
    const path = join(dir, 'judgements.json'); await writeFile(path, JSON.stringify(j));
    const comparison = await compareVerification(f.manifestPath, f.runPath, join(f.options.output, 'verification.json'), path);
    assert.equal(comparison.counts.truePositivesRejected, 1); assert.equal(comparison.counts.falsePositivesRejected, 1);
    assert.equal(comparison.baselineScore.evaluator, 'agent-assisted'); assert.equal(comparison.verificationComplete, true);
    const saved = JSON.parse(await readFile(join(f.options.output, 'verification.json'), 'utf8'));
    saved.results[0].decisions[0].verdict = 'supported'; await writeFile(join(f.options.output, 'verification.json'), JSON.stringify(saved));
    await assert.rejects(compareVerification(f.manifestPath, f.runPath, join(f.options.output, 'verification.json'), path), /verdicts differ/);
  } finally { await f.cleanup(); }
});

test('no-candidate cases require zero calls and native parsers accept only the selected schema', async () => {
  const f = await setup(1, true);
  try {
    const result = await verifyEvaluation({ ...f.options, client: client(() => { throw new Error('Must not run.'); }) });
    assert.equal(result.calls, 0); assert.equal(result.results[0]!.status, 'skipped');
    const response = { requests: [], decisions: [], limitations: [] };
    const claude = JSON.stringify({ type: 'result', subtype: 'success', is_error: false, structured_output: response });
    const grok = JSON.stringify({ stopReason: 'end_turn', num_turns: 1, structuredOutput: response });
    assert.deepEqual(parseClaudeOutput(claude, verificationResponseSchema).result, response);
    assert.deepEqual(parseGrokOutput(grok, verificationResponseSchema).result, response);
    assert.throws(() => parseClaudeOutput(claude)); assert.throws(() => parseGrokOutput(grok));
  } finally { await f.cleanup(); }
});
