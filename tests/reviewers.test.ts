import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, readFile, rm, access, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { configSchema, hash, selectedReviewers, snapshotSchema, type ReviewResult } from '../src/contracts.js';
import { claudeEnvironment, parseClaudeOutput, parseGrokOutput, verifyGrokSession } from '../src/native-providers.js';
import { reviewPrompt } from '../src/provider.js';
import { run } from '../src/process.js';
import { runReviewers } from '../src/reviewers.js';

const snapshot = snapshotSchema.parse(JSON.parse(await readFile(new URL('./fixtures/pr.json', import.meta.url), 'utf8')));
const prompt = reviewPrompt(snapshot);
const clean: ReviewResult = { summary: 'Reviewed supplied context', findings: [], limitations: [] };

test('Claude receives its configured Git Bash path without inheriting unrelated secrets', () => {
  const prior = process.env.CLAUDE_CODE_GIT_BASH_PATH;
  process.env.CLAUDE_CODE_GIT_BASH_PATH = 'C:/custom-git/bin/bash.exe';
  process.env.REVIEW_NATIVE_SECRET = 'not-for-provider';
  try {
    const env = claudeEnvironment('/isolated');
    assert.equal(env.CLAUDE_CODE_GIT_BASH_PATH, process.env.CLAUDE_CODE_GIT_BASH_PATH);
    assert.equal(env.REVIEW_NATIVE_SECRET, undefined); assert.equal(env.GH_TOKEN, undefined); assert.equal(env.XAI_API_KEY, undefined);
  } finally {
    if (prior === undefined) delete process.env.CLAUDE_CODE_GIT_BASH_PATH; else process.env.CLAUDE_CODE_GIT_BASH_PATH = prior;
    delete process.env.REVIEW_NATIVE_SECRET;
  }
});

test('Grok session audit rejects extra tools, tool calls, and modified input', async () => {
  const home = await mkdtemp(join(tmpdir(), 'grok-audit-'));
  const session = join(home, 'sessions', 'isolated');
  await mkdir(session, { recursive: true });
  const definitions = join(session, 'tool_definitions.json'), transcript = join(session, 'chat_history.jsonl');
  const event = { type: 'user', content: [{ type: 'text', text: prompt }] };
  try {
    await writeFile(definitions, JSON.stringify([{ type: 'function', function: { name: 'run_terminal_command' } }]));
    await writeFile(transcript, JSON.stringify(event) + '\n');
    await verifyGrokSession(home, prompt);
    await writeFile(definitions, JSON.stringify([{ type: 'function', function: { name: 'read_file' } }]));
    await assert.rejects(verifyGrokSession(home, prompt), /tool definitions/);
    await writeFile(definitions, '[]');
    await writeFile(transcript, JSON.stringify({ ...event, content: [{ type: 'text', text: prompt.slice(0, 100) }] }) + '\n');
    await assert.rejects(verifyGrokSession(home, prompt), /exact supplied/);
    await writeFile(transcript, [event, { type: 'assistant', content: [{ type: 'tool_use', name: 'run_terminal_command' }] }].map(e => JSON.stringify(e)).join('\n'));
    await assert.rejects(verifyGrokSession(home, prompt), /used tools/);
  } finally { await rm(home, { recursive: true, force: true }); }
});

test('reviewer selection rejects missing models, duplicates, mixed simulation and ambiguous configuration', () => {
  for (const input of [
    { reviewers: [{ name: 'codex' }] },
    { reviewers: [{ name: 'codex', model: 'test' }, { name: 'codex', model: 'test' }] },
    { reviewers: [{ name: 'fake' }, { name: 'grok', model: 'test' }] },
    { reviewers: [{ name: 'grok', model: 'test' }], model: 'test' },
    { reviewer: 'codex', model: 'test', auth: 'browser' },
  ]) assert.throws(() => selectedReviewers(configSchema.parse(input)));
  assert.deepEqual(selectedReviewers(configSchema.parse({ reviewer: 'grok', model: 'test', auth: 'browser' })), [{ name: 'grok', model: 'test', auth: 'browser' }]);
});

test('bounded workers use identical prompts and separate directories; a failed provider preserves peers', async () => {
  const config = configSchema.parse({ reviewers: [{ name: 'codex', model: 'one' }, { name: 'claude', model: 'two' }, { name: 'grok', model: 'three' }], concurrency: 2 });
  let active = 0, peak = 0;
  const directories = new Set<string>(), prompts: string[] = [];
  const reports = await runReviewers({ reviewers: selectedReviewers(config), config, snapshot, prompt, directory: '/isolated', signal: new AbortController().signal,
    adapter: name => ({ probe: async () => 'test-version', review: async (input, reviewer, directory) => {
      active++; peak = Math.max(peak, active); directories.add(directory); prompts.push(input);
      try { await delay(20); if (name === 'claude') throw new Error('Authentication unavailable.'); return { result: clean, model: reviewer.model!, usage: { input_tokens: 12 } }; }
      finally { active--; }
    } }),
  });
  assert.equal(peak, 2); assert.equal(directories.size, 3); assert.deepEqual(prompts, [prompt, prompt, prompt]);
  assert.deepEqual(reports.map(r => r.status), ['complete', 'failed', 'complete']);
  for (const r of reports) { assert.equal(r.contextHash, hash(snapshot)); assert.equal(r.promptHash, hash(prompt)); }
  assert.equal(reports[0]?.model, 'one'); assert.equal(reports[2]?.result?.summary, clean.summary);
});

test('provider deadline releases a worker without cancelling other results', async () => {
  const config = configSchema.parse({ reviewers: [{ name: 'codex', model: 'one' }, { name: 'grok', model: 'two' }], concurrency: 1, providerTimeoutSeconds: 5 });
  const reports = await runReviewers({ reviewers: selectedReviewers(config), config, snapshot, prompt, directory: '/isolated', signal: new AbortController().signal,
    adapter: name => ({ probe: async () => 'test', review: async (_input, reviewer, _dir, signal) => {
      if (name === 'codex') await delay(15_000, undefined, { signal });
      return { result: clean, model: reviewer.model!, usage: null };
    } }),
  });
  assert.deepEqual(reports.map(r => r.status), ['timed_out', 'complete']);
});

test('cancellation preserves finished reviews and records queued providers without starting them', async () => {
  const controller = new AbortController();
  const config = configSchema.parse({ reviewers: [{ name: 'codex', model: 'one' }, { name: 'claude', model: 'two' }, { name: 'grok', model: 'three' }], concurrency: 1 });
  const started: string[] = [];
  const reports = await runReviewers({ reviewers: selectedReviewers(config), config, snapshot, prompt, directory: '/isolated', signal: controller.signal,
    adapter: name => ({ probe: async () => { started.push(name); return 'test'; }, review: async (_input, reviewer, _dir, signal) => {
      if (name === 'claude') { controller.abort(); await delay(10_000, undefined, { signal }); }
      return { result: clean, model: reviewer.model!, usage: null };
    } }),
  });
  assert.deepEqual(reports.map(r => r.status), ['complete', 'cancelled', 'cancelled']);
  assert.deepEqual(started, ['codex', 'claude']); assert.equal(reports[2]?.startedAt, null);
});

test('unsupported CLI version fails only that reviewer before model invocation', async () => {
  const config = configSchema.parse({ reviewers: [{ name: 'grok', model: 'test', version: 'wanted' }] });
  const reports = await runReviewers({ reviewers: selectedReviewers(config), config, snapshot, prompt, directory: '/isolated', signal: new AbortController().signal,
    adapter: () => ({ probe: async () => 'other', review: async () => { assert.fail('Must not invoke incompatible provider'); } }),
  });
  assert.equal(reports[0]?.status, 'failed'); assert.equal(reports[0]?.version, 'other');
});

test('Claude/Grok parsers require successful structured responses and whitelist telemetry', () => {
  const claude = { type: 'result', subtype: 'success', is_error: false, structured_output: clean,
    modelUsage: { 'claude-test': { inputTokens: 3, secret: 'hidden' } }, usage: { input_tokens: 3, secret: 'hidden' }, total_cost_usd: 0.01, permission_denials: [], secret: 'hidden' };
  const grok = { structuredOutput: clean, stopReason: 'end_turn', num_turns: 1, modelUsage: { 'grok-test': { inputTokens: 3, secret: 'hidden' } }, usage: { input_tokens: 3, secret: 'hidden' }, total_cost_usd: 0.01, thought: 'hidden' };
  for (const [parser, envelope] of [[parseClaudeOutput, claude], [parseGrokOutput, grok]] as const) {
    const result = parser(JSON.stringify(envelope));
    assert.equal(result.result.summary, clean.summary); assert.ok(!JSON.stringify(result).includes('hidden'));
    assert.throws(() => parser('invalid'));
  }
  assert.throws(() => parseClaudeOutput(JSON.stringify({ ...claude, is_error: true, result: 'secret=hidden' })), e => e instanceof Error && !e.message.includes('hidden'));
  assert.throws(() => parseClaudeOutput(JSON.stringify({ ...claude, permission_denials: [{ tool_name: 'Bash' }] })), /tool use/);
  assert.throws(() => parseGrokOutput(JSON.stringify({ ...grok, stopReason: 'max_turns' })));
  assert.throws(() => parseGrokOutput(JSON.stringify({ ...grok, num_turns: 2 })));
});

test('invalid findings remain available with provider provenance for later human inspection', async () => {
  const config = configSchema.parse({ reviewer: 'grok', model: 'test' });
  const candidate: ReviewResult = { ...clean, findings: [{ title: 'Invalid anchor', severity: 'high', path: 'math.ts', side: 'RIGHT', line: 99, description: 'Example', trigger: 'Example', impact: 'Example', evidence: 'a - b' }] };
  const reports = await runReviewers({ reviewers: selectedReviewers(config), config, snapshot, prompt, directory: '/isolated', signal: new AbortController().signal,
    adapter: () => ({ probe: async () => 'test', review: async () => ({ result: candidate, model: 'test', usage: null }) }),
  });
  assert.equal(reports[0]?.status, 'partial'); assert.equal(reports[0]?.rawResult?.findings.length, 1);
  assert.equal(reports[0]?.result?.findings.length, 0); assert.equal(reports[0]?.name, 'grok');
});

test('cancelling a subprocess terminates its child process too', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'review-child-'));
  const ready = join(directory, 'ready'), marker = join(directory, 'escaped');
  const controller = new AbortController();
  const script = `const {spawn}=require('node:child_process');const fs=require('node:fs'); const child=spawn(process.execPath,['-e',${JSON.stringify(`require('node:fs').writeFileSync(${JSON.stringify(ready)},'ready');setTimeout(()=>require('node:fs').writeFileSync(${JSON.stringify(marker)},'escaped'),1000);setInterval(()=>{},1000);`)}],{stdio:'inherit'});setInterval(()=>{},1000);`;
  const promise = run(process.execPath, ['-e', script], { signal: controller.signal });
  // Attach a handler immediately to avoid unhandled rejections while awaiting readiness.
  const stopped = assert.rejects(promise, /cancelled/);
  try {
    let found = false;
    for (let i = 0; i < 100; i++) { try { await access(ready); found = true; break; } catch { await delay(20); } }
    assert.ok(found, 'Child did not start'); controller.abort(); await stopped;
    await delay(1100); await assert.rejects(access(marker));
  } finally { controller.abort(); await stopped; await rm(directory, { recursive: true, force: true }); }
});
