#!/usr/bin/env node
import { Command, InvalidArgumentError } from 'commander';
import { configSchema, VERSION } from './contracts.js';
import { githubToken } from './github.js';
import { probeCodex } from './provider.js';
import { probeNative } from './native-providers.js';
import { resolveCodex, run } from './process.js';
import { readJson, review } from './review.js';
import { publish } from './publish.js';
import { actionsGate, actionsReview, actionsPublish, dispatchReview } from './actions.js';

const program = new Command().name('pr-review').description('Independent local PR review reports.').version(VERSION);
const controller = new AbortController();
process.once('SIGINT', () => controller.abort());
process.once('SIGTERM', () => controller.abort());

program.command('dispatch').argument('<pr-url>').description('Request the default-branch Actions review, including after GITHUB_TOKEN bot updates')
  .action(async url => dispatchReview(url, AbortSignal.any([controller.signal, AbortSignal.timeout(30_000)])));

const actions = program.command('actions').description('Trusted hosted-workflow entry points');
actions.command('gate').option('--config <path>', 'Trusted default-branch config', '.github/agent-review.json')
  .option('--output <path>', 'Immutable event packet', '.pr-review/ci/packet')
  .action(async o => actionsGate({ configPath: o.config, outputDirectory: o.output, signal: AbortSignal.any([controller.signal, AbortSignal.timeout(180_000)]) }));
actions.command('review').option('--packet <path>', 'Gate packet', '.pr-review/ci/packet')
  .option('--recovered <path>', 'Original report artifact when recovering')
  .option('--output <path>', 'Report artifact directory', '.pr-review/ci/report')
  .action(async o => actionsReview({ packetDirectory: o.packet, recoveredDirectory: o.recovered, outputDirectory: o.output, signal: controller.signal }));
actions.command('publish').option('--report <path>', 'Verified report artifact', '.pr-review/ci/report')
  .option('--output <path>', 'Publication diagnostics', '.pr-review/ci/publication')
  .action(async o => actionsPublish({ reportDirectory: o.report, outputDirectory: o.output, signal: AbortSignal.any([controller.signal, AbortSignal.timeout(180_000)]) }));

function integer(value: string): number {
  if (!/^\d+$/.test(value) || !Number.isSafeInteger(Number(value))) throw new InvalidArgumentError('Expected a positive integer.');
  return Number(value);
}

program.command('doctor').description('Check local tools and authentication without calling a model')
  .option('--json', 'Print structured diagnostics')
  .option('--reviewer <name>', 'Provider to check: codex, claude, grok', 'codex')
  .option('--auth <mode>', 'Claude/Grok authentication: api-key or browser')
  .action(async options => {
    const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(30_000)]);
    const checks: { name: string; ok: boolean; detail: string }[] = [];
    for (const [name, check] of [
      ['node', async () => { if (Number(process.versions.node.split('.')[0]) !== 24) throw new Error('Use Node.js 24 (see .nvmrc).'); return process.version; }],
      ['git', async () => (await run('git', ['--version'], { signal })).trim()],
      ['github', async () => { await githubToken(signal); return 'Credential available (repository access checked during review)'; }],
      [options.reviewer, async () => {
        if (options.reviewer === 'codex') return probeCodex(signal);
        if (options.reviewer === 'claude' || options.reviewer === 'grok') return probeNative(options.reviewer, signal);
        throw new Error('Choose codex, claude, or grok.');
      }],
      ['provider-auth', async () => {
        if (options.auth && !['api-key', 'browser'].includes(options.auth)) throw new Error('Choose api-key or browser auth.');
        if (options.reviewer === 'claude' || options.reviewer === 'grok') {
          const key = options.reviewer === 'claude' ? process.env.ANTHROPIC_API_KEY : process.env.XAI_API_KEY;
          if (options.auth !== 'browser' && key) return 'API key present; validity checked during review';
          if (options.auth === 'api-key') throw new Error('Configured provider API key is missing.');
          const { stat } = await import('node:fs/promises'); const { join } = await import('node:path'); const { homedir } = await import('node:os');
          await stat(options.reviewer === 'claude'
            ? join(process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), '.claude'), '.credentials.json')
            : join(process.env.GROK_HOME ?? join(homedir(), '.grok'), 'auth.json'));
          return 'Browser credential file present; validity checked during review';
        }
        const exe = await resolveCodex(); await run(exe.command, [...exe.prefix, 'login', 'status'], { signal }); return 'Codex reports authenticated';
      }],
    ] satisfies [string, () => Promise<string>][]) {
      try { checks.push({ name, ok: true, detail: await check() }); }
      catch (error) { checks.push({ name, ok: false, detail: error instanceof Error ? error.message : 'Check failed' }); }
    }
    console.log(options.json ? JSON.stringify({ checks }, null, 2) : checks.map(c => `${c.ok ? 'OK' : 'FAIL'} ${c.name}: ${c.detail}`).join('\n'));
    if (checks.some(c => !c.ok)) process.exitCode = 1;
  });

program.command('publish').argument('<report>', 'Path to report.json')
  .description('Publish evidence-qualified findings as a comment-only GitHub review')
  .option('--dry-run', 'Revalidate live source and save a preview without GitHub writes')
  .option('--allow-partial', 'Explicitly publish a partial report with its limitations visible')
  .option('--max-comments <n>', 'Maximum inline comments, 1–50', integer, 20)
  .option('--state-dir <path>', 'Shared local lock/journal directory', '.pr-review/publications')
  .option('--output-dir <path>', 'Plan/preview directory; defaults to report directory')
  .option('--timeout-seconds <n>', 'Overall publication deadline', integer, 180)
  .action(async (reportPath, options) => {
    if (options.timeoutSeconds < 5 || options.timeoutSeconds > 3600) throw new Error('Publication timeout must be 5–3600 seconds.');
    const result = await publish({ reportPath, stateDirectory: options.stateDir, outputDirectory: options.outputDir,
      allowPartial: !!options.allowPartial, maxComments: options.maxComments, dryRun: !!options.dryRun,
      signal: AbortSignal.any([controller.signal, AbortSignal.timeout(options.timeoutSeconds * 1000)]) });
    console.log(`${result.status.toUpperCase()}: ${result.plan.comments.length} inline findings; ${result.plan.normalized.candidates.filter(c => c.disposition === 'held').length} held.\n${result.journal?.reviewUrl ?? 'Preview saved; no GitHub writes.'}`);
  });

program.command('review').argument('[pr-url]', 'https://github.com/owner/repo/pull/123')
  .description('Capture a PR and write report.json/report.md. No GitHub mutations.')
  .option('--config <path>', 'JSON configuration file')
  .option('--reviewer <name>', 'codex, claude, grok, or fake (single reviewer)')
  .option('--model <id>', 'Explicit model ID (single reviewer); use config reviewers for multiple')
  .option('--auth <mode>', 'Claude/Grok authentication: api-key or browser')
  .option('--concurrency <n>', 'Maximum concurrent reviewers, 1–3', integer)
  .option('--provider-timeout-seconds <n>', 'Deadline per reviewer including capability checks', integer)
  .option('--fixture <path>', 'Offline snapshot JSON; requires fake reviewer')
  .option('--output <directory>', 'Report parent directory', '.pr-review/runs')
  .option('--timeout-seconds <n>', 'Overall deadline, 5–3600 seconds', integer)
  .option('--max-files <n>', 'Maximum supplied files', integer)
  .option('--max-file-bytes <n>', 'Maximum bytes per source file', integer)
  .option('--max-context-bytes <n>', 'Maximum source context bytes', integer)
  .option('--context-file <path...>', 'Additional repository files from the captured head')
  .option('--dry-run', 'Explicit local-only operation (always true in M2)')
  .action(async (url, options) => {
    const fileConfig = configSchema.partial().parse(options.config ? await readJson(options.config, 64_000) : {});
    const overrides = Object.fromEntries(Object.entries({
      reviewer: options.reviewer, model: options.model, auth: options.auth, timeoutSeconds: options.timeoutSeconds,
      concurrency: options.concurrency, providerTimeoutSeconds: options.providerTimeoutSeconds,
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
