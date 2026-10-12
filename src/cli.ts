#!/usr/bin/env node
import { Command, InvalidArgumentError } from 'commander';
import { configSchema, VERSION } from './contracts.js';
import { githubToken } from './github.js';
import { probeCodex } from './provider.js';
import { resolveCodex, run } from './process.js';
import { readJson, review } from './review.js';

const program = new Command().name('pr-review').description('Local PR review reports; M1 never publishes GitHub comments.').version(VERSION);
const controller = new AbortController();
process.once('SIGINT', () => controller.abort());
process.once('SIGTERM', () => controller.abort());

function integer(value: string): number {
  if (!/^\d+$/.test(value) || !Number.isSafeInteger(Number(value))) throw new InvalidArgumentError('Expected a positive integer.');
  return Number(value);
}

program.command('doctor').description('Check local tools and authentication without calling a model')
  .option('--json', 'Print structured diagnostics')
  .action(async options => {
    const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(30_000)]);
    const checks: { name: string; ok: boolean; detail: string }[] = [];
    for (const [name, check] of [
      ['node', async () => { if (Number(process.versions.node.split('.')[0]) !== 24) throw new Error('Use Node.js 24 (see .nvmrc).'); return process.version; }],
      ['git', async () => (await run('git', ['--version'], { signal })).trim()],
      ['github', async () => { await githubToken(signal); return 'Credential available (repository access checked during review)'; }],
      ['codex', async () => probeCodex(signal)],
      ['codex-auth', async () => { const exe = await resolveCodex(); await run(exe.command, [...exe.prefix, 'login', 'status'], { signal }); return 'Codex reports authenticated'; }],
    ] satisfies [string, () => Promise<string>][]) {
      try { checks.push({ name, ok: true, detail: await check() }); }
      catch (error) { checks.push({ name, ok: false, detail: error instanceof Error ? error.message : 'Check failed' }); }
    }
    console.log(options.json ? JSON.stringify({ checks }, null, 2) : checks.map(c => `${c.ok ? 'OK' : 'FAIL'} ${c.name}: ${c.detail}`).join('\n'));
    if (checks.some(c => !c.ok)) process.exitCode = 1;
  });

program.command('review').argument('[pr-url]', 'https://github.com/owner/repo/pull/123')
  .description('Capture a PR and write report.json/report.md. No GitHub mutations.')
  .option('--config <path>', 'JSON configuration file')
  .option('--reviewer <name>', 'codex or fake')
  .option('--model <id>', 'Codex model ID (required for live reviews)')
  .option('--fixture <path>', 'Offline snapshot JSON; requires fake reviewer')
  .option('--output <directory>', 'Report parent directory', '.pr-review/runs')
  .option('--timeout-seconds <n>', 'Overall deadline, 5–3600 seconds', integer)
  .option('--max-files <n>', 'Maximum supplied files', integer)
  .option('--max-file-bytes <n>', 'Maximum bytes per source file', integer)
  .option('--max-context-bytes <n>', 'Maximum source context bytes', integer)
  .option('--context-file <path...>', 'Additional repository files from the captured head')
  .option('--dry-run', 'Explicit local-only operation (always true in M1)')
  .action(async (url, options) => {
    const fileConfig = configSchema.partial().parse(options.config ? await readJson(options.config, 64_000) : {});
    const overrides = Object.fromEntries(Object.entries({
      reviewer: options.reviewer, model: options.model, timeoutSeconds: options.timeoutSeconds,
      maxFiles: options.maxFiles, maxFileBytes: options.maxFileBytes, maxContextBytes: options.maxContextBytes,
      contextFiles: options.contextFile,
    }).filter(([, value]) => value !== undefined));
    const config = configSchema.parse({ ...fileConfig, ...overrides });
    const result = await review({ url, fixture: options.fixture, output: options.output, config, signal: controller.signal, progress: message => console.error(message) });
    console.log(`${result.report.mode.toUpperCase()} ${result.report.status}: ${result.report.result?.findings.length ?? 0} findings\n${result.directory}/report.md\n${result.directory}/report.json`);
    for (const error of result.report.errors) console.error(error);
    process.exitCode = result.report.status === 'cancelled' ? 130 : result.report.status === 'failed' ? 1 : result.report.mode === 'simulation' || result.report.status === 'partial' ? 2 : 0;
  });

try { await program.parseAsync(); }
catch (error) {
  console.error(error instanceof Error && error.name !== 'ZodError' ? error.message : 'Invalid configuration or input. Check supported fields and value limits.');
  process.exitCode = controller.signal.aborted ? 130 : 1;
}
