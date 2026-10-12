import assert from 'node:assert/strict';
import test from 'node:test';
import { parseCodexEvents } from '../src/provider.js';
import { failureHint } from '../src/process.js';

const events = (...items: unknown[]) => items.map(i => JSON.stringify(i)).join('\n');
test('provider requires completed turn and rejects tool events or malformed output', () => {
  assert.throws(() => parseCodexEvents('invalid'), /invalid JSON/);
  assert.throws(() => parseCodexEvents(events({ type: 'turn.started' })), /completed turn/);
  assert.throws(() => parseCodexEvents(events({ type: 'item.completed', item: { type: 'command_execution' } })), /tool use/);
  assert.throws(() => parseCodexEvents(events({ type: 'turn.failed', message: 'secret=do-not-expose' })), error => error instanceof Error && !error.message.includes('do-not-expose'));
});

test('configuration warnings do not become false completed reviews', () => {
  const warning = { type: 'item.completed', item: { type: 'error', message: 'Codex is ignoring 1 unrecognized configuration setting. secret=do-not-expose' } };
  assert.throws(() => parseCodexEvents(events(warning, { type: 'turn.completed' })), /configuration/);
});

test('the pinned CLI warning for intentionally disabled code execution is allowed', () => {
  const warning = { type: 'item.completed', item: { type: 'error', message: 'Code Mode is unavailable because code-mode host is disabled. Code mode will fail closed; enable `features.code_mode_host` and install `codex-code-mode-host`.' } };
  assert.deepEqual(parseCodexEvents(events(warning, { type: 'turn.completed' })), { usage: null, model: null });
});

test('provider retains usage while dropping unknown telemetry fields', () => {
  assert.deepEqual(parseCodexEvents(events(
    { type: 'item.completed', item: { type: 'agent_message', text: '{}' } },
    { type: 'turn.completed', usage: { input_tokens: 123, output_tokens: 45, secret: 'hidden' } },
  )), { usage: { input_tokens: 123, output_tokens: 45 }, model: null });
});

test('diagnostics explain model access failures without exposing raw provider output', () => {
  const hint = failureHint('The model is not supported when using this account. token=secret');
  assert.match(hint, /model is unavailable/);
  assert.ok(!hint.includes('secret'));
});
