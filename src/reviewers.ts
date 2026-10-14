import { join } from 'node:path';
import { hash, VERSION, type Config, type ProviderReport, type Reviewer, type Snapshot } from './contracts.js';
import { validateFindings } from './diff.js';
import { nativeReview, probeNative, type ProviderResponse } from './native-providers.js';
import { codexReview, fakeReview, probeCodex } from './provider.js';

export type Adapter = {
  probe(signal: AbortSignal): Promise<string>;
  review(prompt: string, reviewer: Reviewer, directory: string, signal: AbortSignal): Promise<ProviderResponse>;
};
export function adapterFor(name: Reviewer['name'], config: Config): Adapter {
  if (name === 'fake') return { probe: async () => VERSION, review: async () => ({ result: fakeReview(), model: null, usage: null }) };
  if (name === 'codex') return { probe: probeCodex, review: (prompt, reviewer, directory, signal) => codexReview(prompt, { ...config, model: reviewer.model, auth: reviewer.auth }, directory, signal) };
  return { probe: signal => probeNative(name, signal), review: (prompt, reviewer, directory, signal) => nativeReview(name, prompt, reviewer.model!, directory, signal, reviewer.auth) };
}

export async function runReviewers(options: {
  reviewers: Reviewer[]; config: Config; snapshot: Snapshot; prompt: string; directory: string;
  signal: AbortSignal; adapter?: (name: Reviewer['name']) => Adapter; progress?: (message: string) => void;
  pausedProviders?: Partial<Record<Reviewer['name'], string>>;
}): Promise<ProviderReport[]> {
  const { snapshot, prompt, config, signal } = options;
  const contextHash = hash(snapshot), promptHash = hash(prompt);
  const reports: ProviderReport[] = options.reviewers.map(r => ({
    name: r.name, version: null, requestedModel: r.model ?? null, model: null,
    startedAt: null, finishedAt: null, durationMs: 0, status: 'cancelled',
    contextHash, promptHash, rawResult: null, result: null, errors: [], usage: null,
  }));
  let cursor = 0;
  async function worker(): Promise<void> {
    while (cursor < options.reviewers.length) {
      const index = cursor++, reviewer = options.reviewers[index]!, report = reports[index]!;
      if (signal.aborted) { report.errors.push('Cancelled before this provider started.'); continue; }
      if (options.pausedProviders?.[reviewer.name]) {
        report.status = 'failed'; report.errors.push('Provider paused by the local worker. Resume it explicitly after checking login and usage.'); continue;
      }
      const started = Date.now();
      report.startedAt = new Date(started).toISOString();
      const deadline = AbortSignal.timeout(config.providerTimeoutSeconds * 1000);
      const providerSignal = AbortSignal.any([signal, deadline]);
      try {
        options.progress?.(`Reviewing with ${reviewer.name}…`);
        const adapter = options.adapter?.(reviewer.name) ?? adapterFor(reviewer.name, config);
        report.version = await adapter.probe(providerSignal);
        if (reviewer.version && report.version !== reviewer.version) throw new Error('Installed CLI does not match the configured version.');
        const response = await adapter.review(prompt, reviewer, join(options.directory, reviewer.name), providerSignal);
        if (providerSignal.aborted) throw new Error('Provider deadline exceeded or review cancelled.');
        report.rawResult = response.result;
        report.result = validateFindings(response.result, snapshot);
        report.model = response.model;
        report.usage = response.usage;
        report.status = snapshot.exclusions.length || report.result.limitations.length ? 'partial' : 'complete';
      } catch (error) {
        report.status = signal.aborted ? 'cancelled' : deadline.aborted ? 'timed_out' : 'failed';
        report.errors.push(error instanceof Error && error.name !== 'ZodError' ? error.message : 'Provider output failed schema validation.');
      } finally {
        report.finishedAt = new Date().toISOString(); report.durationMs = Date.now() - started;
        options.progress?.(`${reviewer.name}: ${report.status}`);
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(config.concurrency, options.reviewers.length) }, worker));
  return reports;
}
