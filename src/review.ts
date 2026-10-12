import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rm, stat } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { configSchema, hash, selectedReviewers, snapshotSchema, VERSION, type Config, type Report } from './contracts.js';
import { githubToken, parsePrUrl } from './github.js';
import { reviewPrompt } from './provider.js';
import { runReviewers } from './reviewers.js';
import { saveReport } from './report.js';
import { capturePr, limitSnapshot } from './snapshot.js';

export async function readJson(path: string, maxBytes = 8_000_000): Promise<unknown> {
  const size = (await stat(path)).size;
  if (size > maxBytes) throw new Error('JSON input exceeds the supported size limit.');
  try { return JSON.parse(await readFile(path, 'utf8')); }
  catch { throw new Error('Unable to parse JSON input.'); }
}

export async function review(options: {
  url?: string; fixture?: string; output: string; config: Config; signal?: AbortSignal;
  progress?: (message: string) => void;
}): Promise<{ directory: string; report: Report }> {
  const config = configSchema.parse(options.config);
  const reviewers = selectedReviewers(config);
  const simulation = reviewers[0]!.name === 'fake';
  if (options.fixture) {
    if (!simulation || options.url) throw new Error('--fixture requires --reviewer fake and no PR URL.');
  } else if (!options.url) throw new Error('Provide a PR URL or use --reviewer fake --fixture <snapshot.json>.');
  else parsePrUrl(options.url);
  const runId = `${new Date().toISOString().replace(/[:.]/g, '-')}-${randomUUID().slice(0, 8)}`;
  const directory = resolve(options.output, runId);
  await mkdir(directory, { recursive: true });
  const started = Date.now();
  const signal = AbortSignal.any([AbortSignal.timeout(config.timeoutSeconds * 1000), ...(options.signal ? [options.signal] : [])]);
  const report: Report = {
    schemaVersion: 2, toolVersion: VERSION, runId, startedAt: new Date(started).toISOString(),
    finishedAt: '', durationMs: 0, status: 'failed', mode: simulation ? 'simulation' : 'live',
    outcome: 'inconclusive', config, configHash: hash(config), contextHash: null, promptHash: null,
    provider: { name: reviewers.length === 1 ? reviewers[0]!.name : 'multiple', version: null, model: null }, providers: [], snapshot: null,
    result: null, errors: [], usage: null,
  };
  try {
    options.progress?.('Capturing fixed PR snapshot…');
    report.snapshot = options.fixture
      ? limitSnapshot(snapshotSchema.parse(await readJson(options.fixture)), config)
      : await capturePr(options.url!, await githubToken(signal), directory, config, signal);
    report.contextHash = hash(report.snapshot);
    const prompt = reviewPrompt(report.snapshot);
    report.promptHash = hash(prompt);
    if (!report.snapshot.files.some(f => f.kind === 'change')) throw new Error('No reviewable changed text files remain in the supplied context. See coverage exclusions.');
    if (signal.aborted) throw new Error('Review cancelled or deadline exceeded.');
    report.providers = await runReviewers({ reviewers, config, snapshot: report.snapshot, prompt, directory, signal, progress: options.progress });
    const successful = report.providers.filter(p => p.result !== null);
    if (successful.length) report.result = {
      summary: successful.map(p => `${p.name}: ${p.result!.summary}`).join('\n'),
      findings: successful.flatMap(p => p.result!.findings),
      limitations: successful.flatMap(p => p.result!.limitations.map(l => `${p.name}: ${l}`)),
    };
    if (report.providers.length === 1) {
      const p = report.providers[0]!;
      report.provider = { name: p.name, version: p.version, model: p.model ?? p.requestedModel };
      report.usage = p.usage;
    }
    report.errors = report.providers.flatMap(p => p.errors.map(e => `${p.name}: ${e}`));
    report.status = signal.aborted ? 'cancelled' : !successful.length ? 'failed' : report.providers.every(p => p.status === 'complete') ? 'complete' : 'partial';
    report.outcome = simulation ? 'inconclusive' : report.result?.findings.length ? 'findings' : report.status === 'complete' ? 'no_findings' : 'inconclusive';
  } catch (error) {
    report.status = signal.aborted ? 'cancelled' : 'failed';
    // Validation errors may echo source or secrets; only persist bounded, controlled diagnostics.
    report.errors.push(error instanceof Error && error.name !== 'ZodError' ? error.message : 'Input or provider output failed schema validation.');
  } finally {
    try { await rm(join(directory, 'snapshot.git'), { recursive: true, force: true }); }
    catch { report.errors.push('Temporary Git snapshot cleanup failed. Remove snapshot.git from this run directory.'); }
    if (report.errors.length && report.status === 'complete') report.status = 'partial';
    if (report.status !== 'complete' && report.outcome === 'no_findings') report.outcome = 'inconclusive';
    report.finishedAt = new Date().toISOString();
    report.durationMs = Date.now() - started;
    await saveReport(directory, report);
  }
  return { directory, report };
}
