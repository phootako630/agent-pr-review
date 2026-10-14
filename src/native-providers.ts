import { chmod, copyFile, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { z } from 'zod';
import { outputJsonSchema, resultSchema, type ReviewResult } from './contracts.js';
import { baseEnvironment, failureHint, resolveNative, run } from './process.js';
import { readBrowserCredentials } from './browser-auth.js';

export type ProviderResponse = { result: ReviewResult; model: string | null; usage: unknown };
// Complete built-in catalog observed in the pinned Grok 1.0.50 session protocol.
// An empty --tools argument alone retains the default catalog in this version.
export const grokDisallowedTools = [
  'run_terminal_command', 'read_file', 'search_replace', 'list_dir', 'grep',
  'kill_command_or_subagent', 'todo_write', 'get_command_or_subagent_output', 'spawn_subagent',
  'scheduler_create', 'scheduler_delete', 'scheduler_list', 'monitor', 'search_tool', 'use_tool',
  'workflow', 'enter_plan_mode', 'exit_plan_mode', 'ask_user_question', 'send_feedback',
  'image_gen', 'image_edit', 'image_to_video', 'reference_to_video', 'write',
].join(',');
const usageSchema = z.object({
  input_tokens: z.number().nonnegative().optional(), output_tokens: z.number().nonnegative().optional(),
  cache_read_input_tokens: z.number().nonnegative().optional(), cache_creation_input_tokens: z.number().nonnegative().optional(),
});

export function claudeEnvironment(home: string): NodeJS.ProcessEnv {
  return { ...baseEnvironment(), HOME: home, USERPROFILE: home, APPDATA: home, LOCALAPPDATA: home,
    CLAUDE_CONFIG_DIR: home,
    ...(process.env.CLAUDE_CODE_GIT_BASH_PATH ? { CLAUDE_CODE_GIT_BASH_PATH: process.env.CLAUDE_CODE_GIT_BASH_PATH } : {}) };
}

export async function verifyGrokSession(home: string, prompt: string): Promise<void> {
  const root = join(home, 'sessions');
  let files: string[];
  try { files = await readdir(root, { recursive: true }); }
  catch { throw new Error('Grok session audit is unavailable. Output rejected.'); }
  const definitions = files.filter(f => f.endsWith('tool_definitions.json'));
  const transcripts = files.filter(f => f.endsWith('chat_history.jsonl'));
  if (definitions.length !== 1 || transcripts.length !== 1) throw new Error('Grok session audit does not match the supported protocol.');
  try {
    const tools = JSON.parse(await readFile(join(root, definitions[0]!), 'utf8'));
    // This CLI always retains its primary terminal definition. Permissions deny all
    // execution; reject any other retained tool and any attempted call below.
    if (!Array.isArray(tools) || tools.some(t => t?.function?.name !== 'run_terminal_command') || tools.length > 1) throw new Error();
  } catch { throw new Error('Grok retained tool definitions in a tool-free review. Output rejected.'); }
  try {
    const lines = (await readFile(join(root, transcripts[0]!), 'utf8')).split('\n').filter(Boolean);
    const events = lines.map(line => JSON.parse(line));
    if (events.some(event => Array.isArray(event.content) && event.content.some((c: { type?: string }) => c.type === 'tool_use' || c.type === 'tool_result'))) throw new Error();
    const hasExactInput = events.some(event => {
      return event.type === 'user' && Array.isArray(event.content) && event.content.some((c: { type?: string; text?: string }) => c.type === 'text' && c.text === prompt);
    });
    if (!hasExactInput) throw new Error();
  } catch { throw new Error('Grok session used tools or did not record the exact supplied review packet. Output rejected.'); }
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
  for (const flag of ['--tools', '--json-schema', '--output-format', ...(name === 'claude' ? ['--bare', '--safe-mode', '--restricted', '--strict-mcp-config', '--no-session-persistence'] : ['--disallowed-tools', '--prompt-file', '--verbatim', '--disable-web-search', '--no-subagents'])]) {
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
        if (auth === 'browser') await writeFile(join(home, '.credentials.json'), JSON.stringify(await readBrowserCredentials('claude')), { mode: 0o600 });
        else {
          try {
            const credentials = JSON.parse(await readFile(join(process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), '.claude'), '.credentials.json'), 'utf8'));
            if (!credentials.claudeAiOauth) throw new Error();
            await writeFile(join(home, '.credentials.json'), JSON.stringify({ claudeAiOauth: credentials.claudeAiOauth }), { mode: 0o600 });
          } catch { throw new Error('Claude browser credentials unavailable. Run claude auth login or choose api-key auth.'); }
        }
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
      if (auth === 'browser') await writeFile(join(home, 'auth.json'), JSON.stringify(await readBrowserCredentials('grok')), { mode: 0o600 });
      else {
        try {
          await copyFile(join(process.env.GROK_HOME ?? join(homedir(), '.grok'), 'auth.json'), join(home, 'auth.json'));
          await chmod(join(home, 'auth.json'), 0o600);
        } catch { throw new Error('Grok authentication unavailable. Run grok login or set XAI_API_KEY.'); }
      }
    }
    const config = '[cli]\nauto_update = false\n[session]\nload_envrc = false\n[permission]\nrules = [{ action = "deny", tool = "any" }]\n[compat.cursor]\nskills = false\nrules = false\nagents = false\nmcps = false\nhooks = false\n[compat.claude]\nskills = false\nrules = false\nagents = false\nmcps = false\nhooks = false\n';
    await writeFile(join(home, 'config.toml'), config, { mode: 0o600 });
    const promptPath = join(sandbox, 'prompt.txt');
    await writeFile(promptPath, prompt, { mode: 0o600 });
    const output = await run(exe.command, ['--no-auto-update', '--verbatim', '--prompt-file', promptPath, '--model', model,
      '--cwd', cwd, '--tools', 'none', '--disallowed-tools', grokDisallowedTools, '--disable-web-search', '--no-subagents', '--no-plan',
      '--permission-mode', 'dontAsk', '--max-turns', '1', '--output-format', 'json', '--json-schema', JSON.stringify(outputJsonSchema)],
    { cwd, env: { ...env, GROK_HOME: home, GROK_MEMORY: '0', GROK_GOAL: '0', GROK_DISABLE_AUTOUPDATER: '1',
      ...(apiKey ? { XAI_API_KEY: process.env.XAI_API_KEY } : {}) }, signal });
    await verifyGrokSession(home, prompt);
    return parseGrokOutput(output);
  } finally { await rm(sandbox, { recursive: true, force: true }); }
}
