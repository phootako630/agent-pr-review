import { chmod, copyFile, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { z } from 'zod';
import { outputJsonSchema, resultSchema, type ReviewResult } from './contracts.js';
import { baseEnvironment, failureHint, resolveNative, run } from './process.js';

export type ProviderResponse = { result: ReviewResult; model: string | null; usage: unknown };
const usageSchema = z.object({
  input_tokens: z.number().nonnegative().optional(), output_tokens: z.number().nonnegative().optional(),
  cache_read_input_tokens: z.number().nonnegative().optional(), cache_creation_input_tokens: z.number().nonnegative().optional(),
});

export function claudeEnvironment(home: string): NodeJS.ProcessEnv {
  return { ...baseEnvironment(), HOME: home, USERPROFILE: home, APPDATA: home, LOCALAPPDATA: home,
    CLAUDE_CONFIG_DIR: home,
    ...(process.env.CLAUDE_CODE_GIT_BASH_PATH ? { CLAUDE_CODE_GIT_BASH_PATH: process.env.CLAUDE_CODE_GIT_BASH_PATH } : {}) };
}

export function parseClaudeOutput(output: string): ProviderResponse {
  let value;
  try { value = JSON.parse(output); } catch { throw new Error('Claude returned invalid JSON.'); }
  const envelope = z.object({
    type: z.literal('result'), subtype: z.literal('success'), is_error: z.literal(false),
    structured_output: resultSchema, usage: usageSchema.optional(),
    total_cost_usd: z.number().nonnegative().optional(),
    modelUsage: z.record(z.string(), z.object({
      inputTokens: z.number().nonnegative().optional(), outputTokens: z.number().nonnegative().optional(),
      cacheReadInputTokens: z.number().nonnegative().optional(), cacheCreationInputTokens: z.number().nonnegative().optional(),
      costUSD: z.number().nonnegative().optional(),
    })).optional(),
    permission_denials: z.array(z.unknown()).optional(),
  }).safeParse(value);
  if (!envelope.success) throw new Error(`Claude did not return a successful schema-constrained review. ${failureHint(String(value?.result ?? ''))}`);
  const data = envelope.data;
  if (data.permission_denials?.length) throw new Error('Claude attempted disallowed tool use. Output rejected.');
  const models = Object.keys(data.modelUsage ?? {});
  return { result: data.structured_output, model: models.length === 1 ? models[0]! : null,
    usage: { tokens: data.usage ?? null, estimatedCostUsd: data.total_cost_usd ?? null, models: data.modelUsage ?? {} } };
}

export function parseGrokOutput(output: string): ProviderResponse {
  let value;
  try { value = JSON.parse(output); } catch { throw new Error('Grok returned invalid JSON.'); }
  // Grok's headless JSON protocol is checked against the pinned version and live smoke.
  const envelope = z.object({
    stopReason: z.literal('end_turn'), structuredOutput: resultSchema, num_turns: z.literal(1),
    usage: usageSchema.optional(), total_cost_usd: z.number().nonnegative().optional(),
    modelUsage: z.record(z.string(), z.object({
      inputTokens: z.number().nonnegative().optional(), outputTokens: z.number().nonnegative().optional(),
      cacheReadInputTokens: z.number().nonnegative().optional(), cacheCreationInputTokens: z.number().nonnegative().optional(),
      modelCalls: z.number().nonnegative().optional(), costUSD: z.number().nonnegative().optional(),
    })).optional(),
  }).safeParse(value);
  if (!envelope.success) throw new Error('Grok output does not match the supported headless protocol.');
  const data = envelope.data, models = Object.keys(data.modelUsage ?? {});
  return { result: data.structuredOutput, model: models.length === 1 ? models[0]! : null,
    usage: { tokens: data.usage ?? null, estimatedCostUsd: data.total_cost_usd ?? null, models: data.modelUsage ?? {} } };
}

export async function probeNative(name: 'claude' | 'grok', signal: AbortSignal): Promise<string> {
  const exe = await resolveNative(name);
  const prefix = name === 'grok' ? ['--no-auto-update'] : [];
  const version = (await run(exe.command, [...exe.prefix, ...prefix, '--version'], { signal, env: baseEnvironment() })).trim();
  const supported = name === 'claude' ? '2.1.293 (Claude Code)' : 'grok 1.0.50 (c58f321264ba)';
  if (version !== supported) throw new Error(`${name} CLI protocol is supported at ${supported}; installed version differs.`);
  const help = await run(exe.command, [...exe.prefix, ...prefix, '--help'], { signal, env: baseEnvironment() });
  for (const flag of ['--tools', '--json-schema', '--output-format', ...(name === 'claude' ? ['--bare', '--safe-mode', '--restricted', '--strict-mcp-config', '--no-session-persistence'] : ['--prompt-file', '--verbatim', '--disable-web-search', '--no-subagents'])]) {
    if (!help.includes(flag)) throw new Error(`${name} CLI lacks required capability ${flag}.`);
  }
  return version;
}

export async function nativeReview(name: 'claude' | 'grok', prompt: string, model: string, directory: string, signal: AbortSignal, auth?: 'api-key' | 'browser'): Promise<ProviderResponse> {
  const exe = await resolveNative(name);
  const sandbox = resolve(directory, 'provider');
  const home = join(sandbox, 'home');
  const cwd = join(sandbox, 'empty');
  await mkdir(home, { recursive: true });
  await mkdir(cwd, { recursive: true });
  const env = { ...baseEnvironment(), HOME: home, USERPROFILE: home, APPDATA: home, LOCALAPPDATA: home };
  try {
    if (name === 'claude') {
      const apiKey = auth !== 'browser' && !!process.env.ANTHROPIC_API_KEY;
      if (auth === 'api-key' && !apiKey) throw new Error('Set ANTHROPIC_API_KEY for Claude API-key mode.');
      if (!apiKey) {
        try {
          const credentials = JSON.parse(await readFile(join(process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), '.claude'), '.credentials.json'), 'utf8'));
          if (!credentials.claudeAiOauth) throw new Error();
          await writeFile(join(home, '.credentials.json'), JSON.stringify({ claudeAiOauth: credentials.claudeAiOauth }), { mode: 0o600 });
        } catch { throw new Error('Claude browser credentials unavailable. Run claude auth login or choose api-key auth.'); }
      }
      const output = await run(exe.command, [...exe.prefix, '-p', ...(apiKey ? ['--bare'] : ['--safe-mode', '--restricted', '--setting-sources', '', '--settings', '{"disableAllHooks":true}']), '--model', model,
        '--tools', '', '--strict-mcp-config', '--mcp-config', '{"mcpServers":{}}',
        '--no-session-persistence', '--disable-slash-commands', '--no-chrome',
        '--permission-mode', 'dontAsk', '--output-format', 'json', '--json-schema', JSON.stringify(outputJsonSchema)],
      { cwd, env: { ...claudeEnvironment(home), ...(apiKey ? { ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY } : {}) }, input: prompt, signal });
      return parseClaudeOutput(output);
    }
    const apiKey = auth !== 'browser' && !!process.env.XAI_API_KEY;
    if (auth === 'api-key' && !apiKey) throw new Error('Set XAI_API_KEY for Grok API-key mode.');
    if (!apiKey) {
      try {
        await copyFile(join(process.env.GROK_HOME ?? join(homedir(), '.grok'), 'auth.json'), join(home, 'auth.json'));
        await chmod(join(home, 'auth.json'), 0o600);
      } catch { throw new Error('Grok authentication unavailable. Run grok login or set XAI_API_KEY.'); }
    }
    const config = '[cli]\nauto_update = false\n[session]\nload_envrc = false\n[permission]\nrules = [{ action = "deny", tool = "any" }]\n[compat.cursor]\nskills = false\nrules = false\nagents = false\nmcps = false\nhooks = false\n[compat.claude]\nskills = false\nrules = false\nagents = false\nmcps = false\nhooks = false\n';
    await writeFile(join(home, 'config.toml'), config, { mode: 0o600 });
    const promptPath = join(sandbox, 'prompt.txt');
    await writeFile(promptPath, prompt, { mode: 0o600 });
    const output = await run(exe.command, ['--no-auto-update', '--verbatim', '--prompt-file', promptPath, '--model', model,
      '--cwd', cwd, '--tools', '', '--disable-web-search', '--no-subagents', '--no-plan',
      '--permission-mode', 'dontAsk', '--max-turns', '1', '--output-format', 'json', '--json-schema', JSON.stringify(outputJsonSchema)],
    { cwd, env: { ...env, GROK_HOME: home, GROK_MEMORY: '0', GROK_GOAL: '0', GROK_DISABLE_AUTOUPDATER: '1',
      ...(apiKey ? { XAI_API_KEY: process.env.XAI_API_KEY } : {}) }, signal });
    return parseGrokOutput(output);
  } finally { await rm(sandbox, { recursive: true, force: true }); }
}
