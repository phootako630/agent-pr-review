import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { browserCredentials } from '../src/browser-auth.js';
import { configSchema } from '../src/contracts.js';
import { adapterFor } from '../src/reviewers.js';

const codex = { OPENAI_API_KEY: null, tokens: { id_token: 'id', access_token: 'access', refresh_token: 'refresh', account_id: 'account' } };

test('browser credentials validate supported login shapes and discard API/MCP credentials', () => {
  assert.equal((browserCredentials('codex', codex) as any).auth_mode, 'chatgpt');
  assert.throws(() => browserCredentials('codex', { ...codex, OPENAI_API_KEY: 'do-not-print-key' }), error => error instanceof Error && !error.message.includes('do-not-print-key'));
  assert.throws(() => browserCredentials('codex', { OPENAI_API_KEY: 'key', auth_mode: 'apikey' }));
  const claude = browserCredentials('claude', { claudeAiOauth: { accessToken: 'access', refreshToken: 'refresh', expiresAt: 123, scopes: ['inference'], subscriptionType: 'max' }, mcpOAuth: { unrelated: 'private' }, apiKey: 'key' });
  assert.deepEqual(Object.keys(claude as object), ['claudeAiOauth']);
  const grok = browserCredentials('grok', { 'browser-session': { auth_mode: 'oidc', key: 'oauth', refresh_token: 'refresh', oidc_issuer: 'https://auth.x.ai', oidc_client_id: 'client' }, 'api-session': { auth_mode: 'api_key', key: 'key' } });
  assert.deepEqual(Object.keys(grok as object), ['browser-session']);
  assert.throws(() => browserCredentials('grok', { api: { auth_mode: 'api_key', key: 'key' } }));
});

test('Codex browser reviewer ignores an inherited API key and never falls back when login is missing', async () => {
  const root = await mkdtemp(join(tmpdir(), 'apr-browser-')), savedEnv = { ...process.env };
  try {
    const binaryRoot = join(root, 'node_modules', '.bin'), scriptRoot = join(root, 'node_modules', '@openai', 'codex', 'bin'), authRoot = join(root, 'original-auth');
    await mkdir(binaryRoot, { recursive: true }); await mkdir(scriptRoot, { recursive: true }); await mkdir(authRoot);
    await writeFile(join(authRoot, 'auth.json'), JSON.stringify(codex));
    const script = `const fs = require('node:fs'); const path = require('node:path');
if (process.env.OPENAI_API_KEY) throw new Error('API key reached browser provider');
const auth = JSON.parse(fs.readFileSync(path.join(process.env.CODEX_HOME, 'auth.json'), 'utf8'));
if (auth.auth_mode !== 'chatgpt' || auth.OPENAI_API_KEY !== null) throw new Error('Wrong auth route');
const output = process.argv[process.argv.indexOf('--output-last-message') + 1];
fs.writeFileSync(output, JSON.stringify({summary:'Browser-route transport fixture.',findings:[],limitations:[]}));
console.log(JSON.stringify({type:'turn.completed',usage:{input_tokens:1,output_tokens:1}}));`;
    if (process.platform === 'win32') await writeFile(join(scriptRoot, 'codex.js'), script);
    else { await writeFile(join(binaryRoot, 'codex'), '#!/usr/bin/env node\n' + script, { mode: 0o755 }); }
    process.env.PATH = `${binaryRoot}${process.platform === 'win32' ? ';' : ':'}${process.env.PATH}`;
    process.env.CODEX_HOME = authRoot; process.env.OPENAI_API_KEY = 'inherited-api-key-should-not-be-used';
    const config = configSchema.parse({ reviewers: [{ name: 'codex', model: 'fixture', auth: 'browser' }] });
    const reviewer = config.reviewers![0]!;
    const result = await adapterFor('codex', config).review('fixture', reviewer, join(root, 'run'), AbortSignal.timeout(10_000));
    assert.equal(result.result.summary, 'Browser-route transport fixture.');
    await writeFile(join(authRoot, 'auth.json'), JSON.stringify({ OPENAI_API_KEY: 'stored-api-key', auth_mode: 'apikey' }));
    await assert.rejects(adapterFor('codex', config).review('fixture', reviewer, join(root, 'refused'), AbortSignal.timeout(10_000)), /API-key fallback is disabled/);
    assert.deepEqual(JSON.parse(await readFile(join(authRoot, 'auth.json'), 'utf8')), { OPENAI_API_KEY: 'stored-api-key', auth_mode: 'apikey' });
  } finally {
    for (const key of Object.keys(process.env)) if (!(key in savedEnv)) delete process.env[key]; Object.assign(process.env, savedEnv);
    await rm(root, { recursive: true, force: true });
  }
});
