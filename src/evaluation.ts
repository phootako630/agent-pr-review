import { mkdir, readFile, realpath, writeFile, open, rm } from 'node:fs/promises';
import { dirname, join, relative, resolve, isAbsolute } from 'node:path';
import { z } from 'zod';
import { configSchema, hash, repoPath, selectedReviewers, snapshotSchema, VERSION, type Config, type ProviderReport, type Snapshot } from './contracts.js';
import { reportInputSchema, same, stableHash } from './report-input.js';
import { readJson } from './review.js';
import { reviewPrompt } from './provider.js';
import { runReviewers, type Adapter } from './reviewers.js';
import { limitSnapshot } from './snapshot.js';
import { validateFindings } from './diff.js';

const digest = z.string().regex(/^[a-f0-9]{64}$/);
const id = z.string().regex(/^[a-z0-9][a-z0-9-]{0,79}$/);
export const evalManifestSchema = z.strictObject({
  schemaVersion: z.literal(1), datasetId: id, description: z.string().max(4000),
  cases: z.array(z.strictObject({
    id, split: z.enum(['dev', 'test']), group: id, language: z.string().max(40),
    source: z.strictObject({ kind: z.enum(['public', 'synthetic']), url: z.string().url(), revision: z.string().min(1).max(200), license: z.string().min(1).max(200) }),
    snapshot: repoPath, snapshotHash: digest, labels: repoPath, labelsHash: digest,
  })).min(1).max(500),
});
export type EvalManifest = z.infer<typeof evalManifestSchema>;
export const evalLabelsSchema = z.strictObject({
  caseId: id, snapshotHash: digest,
  provenance: z.enum(['upstream-reference', 'curated-fixture', 'human-confirmed']),
  completeness: z.enum(['known-issues-only', 'exhaustive-fixture']),
  issues: z.array(z.strictObject({ id, description: z.string().min(1).max(8000), evidence: z.string().min(1).max(8000) })).max(100),
  notes: z.string().max(8000),
});
export type EvalLabels = z.infer<typeof evalLabelsSchema>;

// Deliberately separate from publishable Report: an evaluation cannot be posted by `publish`.
export const RUBRIC_VERSION = 'evidence-v1';
export const EVAL_RUBRIC = `Review rubric ${RUBRIC_VERSION}:
1. Inspect introduced correctness, security, reliability and data-loss defects against the supplied intent and contracts.
2. For each candidate, state the concrete trigger, observable impact and exact source evidence in the existing output fields.
3. Challenge the claim: look for guards, caller constraints, intentional behavior, and other counterexamples in the supplied context.
4. Do not turn absent context into an assumption that a bug exists. Omit style preferences and unsupported speculation.
5. Missing context belongs in limitations. A source quote or agreement with another model is not proof of a defect.
6. Do not invent findings to fill a quota; an empty findings list is valid. No tests or external investigation were performed.
`;
export function evalPrompt(snapshot: Snapshot, mode: 'current' | 'rubric'): string {
  return (mode === 'rubric' ? EVAL_RUBRIC + '\n' : '') + reviewPrompt(snapshot);
}

async function inside(root: string, path: string): Promise<string> {
  repoPath.parse(path);
  const base = await realpath(root), file = await realpath(resolve(base, path));
  const rel = relative(base, file);
  if (rel === '..' || rel.startsWith('..' + (process.platform === 'win32' ? '\\' : '/')) || isAbsolute(rel)) throw new Error('Evaluation file escapes dataset directory.');
  return file;
}
export async function loadEvaluation(path: string, checkLabels = false): Promise<{ manifest: EvalManifest; root: string; snapshots: Map<string, Snapshot> }> {
  const root = dirname(resolve(path));
  const manifest = evalManifestSchema.parse(await readJson(path, 2_000_000));
  const ids = new Set<string>(), groups = new Map<string, string>(), revisions = new Map<string, string>();
  const snapshots = new Map<string, Snapshot>();
  for (const item of manifest.cases) {
    if (ids.has(item.id)) throw new Error('Duplicate evaluation case ID.');
    ids.add(item.id);
    if (groups.has(item.group) && groups.get(item.group) !== item.split) throw new Error('Related cases cross dev/test splits.');
    groups.set(item.group, item.split);
    const snapshot = snapshotSchema.parse(await readJson(await inside(root, item.snapshot)));
    if (stableHash(snapshot) !== item.snapshotHash) throw new Error(`Snapshot hash mismatch: ${item.id}`);
    const revision = `${snapshot.repository.toLowerCase()}/${snapshot.pr}`;
    if (revisions.has(revision) && revisions.get(revision) !== item.split) throw new Error('PR revisions cross dev/test splits.');
    revisions.set(revision, item.split);
    if (!snapshot.files.some(f => f.kind === 'change')) throw new Error('Evaluation case has no reviewable source.');
    snapshots.set(item.id, snapshot);
    if (checkLabels) {
      const labels = evalLabelsSchema.parse(await readJson(await inside(root, item.labels)));
      if (labels.caseId !== item.id || labels.snapshotHash !== item.snapshotHash || stableHash(labels) !== item.labelsHash) throw new Error(`Label identity/hash mismatch: ${item.id}`);
      if (new Set(labels.issues.map(i => i.id)).size !== labels.issues.length) throw new Error('Duplicate known issue ID.');
    }
  }
  return { manifest, root, snapshots };
}

export type EvalCaseRun = {
  caseId: string; snapshotHash: string; promptHash: string; mode: 'live' | 'simulation';
  providers: ProviderReport[]; durationMs: number; status: 'complete' | 'partial' | 'failed';
};
const caseRunSchema = z.strictObject({ caseId: id, snapshotHash: digest, promptHash: digest, mode: z.literal('live'),
  providers: reportInputSchema.shape.providers, durationMs: z.number().nonnegative(), status: z.enum(['complete', 'partial', 'failed']) });
const identitySchema = z.strictObject({ schemaVersion: z.literal(1), kind: z.literal('evaluation'), toolVersion: z.string().min(1),
  datasetHash: digest, config: configSchema, split: z.enum(['dev', 'test']), promptMode: z.enum(['current', 'rubric']),
  rubricVersion: z.literal(RUBRIC_VERSION), rubricHash: digest, cases: z.array(id), promptHashes: z.array(digest) });
const runSchema = z.strictObject({ experimentHash: digest, identity: identitySchema, selected: z.number().int().positive(), finished: z.number().int().nonnegative(),
  failed: z.number().int().nonnegative(), durationMs: z.number().nonnegative(), candidates: z.number().int().nonnegative(),
  scoring: z.literal('pending-adjudication'), actualBilledCost: z.null(), results: z.array(caseRunSchema) });
function validateCaseRun(input: unknown, snapshot: Snapshot, config: Config, prompt: string, caseId: string): EvalCaseRun {
  const result = caseRunSchema.parse(input), reviewers = selectedReviewers(config);
  if (result.caseId !== caseId || result.snapshotHash !== stableHash(snapshot) || result.promptHash !== stableHash(prompt) || result.providers.length !== reviewers.length) throw new Error('Saved evaluation result identity differs.');
  for (const [i, p] of result.providers.entries()) {
    const reviewer = reviewers[i]!;
    if (p.name !== reviewer.name || p.requestedModel !== reviewer.model || p.contextHash !== hash(snapshot) || p.promptHash !== hash(prompt)) throw new Error('Evaluation provider provenance differs.');
    const success = ['complete', 'partial'].includes(p.status);
    if (success !== !!p.result || success !== !!p.rawResult) throw new Error('Evaluation provider status/result differs.');
    if (success && (!same(validateFindings(p.rawResult!, snapshot), p.result) || !p.version || p.errors.length || (reviewer.version && p.version !== reviewer.version))) throw new Error('Evaluation evidence/protocol validation differs.');
    if (success && (p.status !== (snapshot.exclusions.length || p.result!.limitations.length ? 'partial' : 'complete') || !p.startedAt || !p.finishedAt)) throw new Error('Evaluation provider coverage/timestamps differ.');
  }
  const status = result.providers.every(p => p.status === 'complete') ? 'complete' : result.providers.some(p => !p.result) ? 'failed' : 'partial';
  if (status !== result.status) throw new Error('Evaluation completion status differs.');
  return result;
}
function validateRun(input: unknown, dataset: Awaited<ReturnType<typeof loadEvaluation>>) {
  const run = runSchema.parse(input), identity = run.identity;
  if (stableHash(identity) !== run.experimentHash || identity.datasetHash !== stableHash(dataset.manifest) || identity.rubricHash !== stableHash(EVAL_RUBRIC)) throw new Error('Run and dataset identities differ.');
  const selected = dataset.manifest.cases.filter(c => c.split === identity.split).slice(0, identity.cases.length);
  if (!same(selected.map(c => c.id), identity.cases) || run.selected !== selected.length || run.finished !== run.results.length || new Set(run.results.map(r => r.caseId)).size !== run.results.length) throw new Error('Run selection/counts differ.');
  if (!same(selected.map(c => stableHash(evalPrompt(dataset.snapshots.get(c.id)!, identity.promptMode))), identity.promptHashes)) throw new Error('Run prompts differ from frozen strategy.');
  for (const r of run.results) {
    if (!identity.cases.includes(r.caseId)) throw new Error('Run contains unselected cases.');
    validateCaseRun(r, dataset.snapshots.get(r.caseId)!, identity.config, evalPrompt(dataset.snapshots.get(r.caseId)!, identity.promptMode), r.caseId);
  }
  if (run.failed !== run.results.filter(r => r.status === 'failed').length || run.candidates !== run.results.reduce((n, r) => n + evalCandidates(r).length, 0)) throw new Error('Run summary differs from case results.');
  return run;
}
export function evalCandidates(run: EvalCaseRun) {
  const candidates = new Map<string, { id: string; finding: NonNullable<ProviderReport['result']>['findings'][number]; providers: string[] }>();
  for (const p of run.providers) for (const finding of p.result?.findings ?? []) {
    const key = stableHash(finding), existing = candidates.get(key);
    if (existing) existing.providers.push(p.name);
    else candidates.set(key, { id: key, finding, providers: [p.name] });
  }
  return [...candidates.values()];
}

export async function runEvaluation(options: {
  manifestPath: string; config: Config; split: 'dev' | 'test'; promptMode: 'current' | 'rubric';
  output: string; limit: number; maxCalls: number; signal: AbortSignal; resume?: boolean;
  adapter?: (name: import('./contracts.js').Reviewer['name']) => Adapter;
  progress?: (message: string) => void;
}) {
  const loaded = await loadEvaluation(options.manifestPath); // Never opens labels during inference.
  const config = configSchema.parse(options.config), reviewers = selectedReviewers(config);
  if (reviewers.some(r => r.name === 'fake' || r.auth !== 'browser')) throw new Error('Evaluation requires explicit browser-authenticated live reviewers; no API fallback.');
  if (!Number.isSafeInteger(options.limit) || options.limit < 1 || !Number.isSafeInteger(options.maxCalls) || options.maxCalls < 1) throw new Error('Set positive case and model-call limits.');
  const cases = loaded.manifest.cases.filter(c => c.split === options.split).slice(0, options.limit);
  if (!cases.length) throw new Error('No cases in selected split.');
  for (const c of cases) if (stableHash(limitSnapshot(loaded.snapshots.get(c.id)!, config)) !== c.snapshotHash) throw new Error(`Configuration would change fixed evaluation context: ${c.id}. Increase context limits.`);
  const identity = { schemaVersion: 1, kind: 'evaluation' as const, toolVersion: VERSION, datasetHash: stableHash(loaded.manifest), config,
    split: options.split, promptMode: options.promptMode, rubricVersion: RUBRIC_VERSION, rubricHash: stableHash(EVAL_RUBRIC), cases: cases.map(c => c.id),
    promptHashes: cases.map(c => stableHash(evalPrompt(loaded.snapshots.get(c.id)!, options.promptMode))) };
  const experimentHash = stableHash(identity), output = resolve(options.output);
  await mkdir(output, { recursive: true });
  let lock;
  try { lock = await open(join(output, 'evaluation.lock'), 'wx', 0o600); }
  catch { throw new Error('Evaluation output is locked. Inspect the prior process before removing its lock.'); }
  await lock.writeFile(JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }) + '\n');
  const results: EvalCaseRun[] = [];
  try {
    const identityPath = join(output, 'experiment.json');
    if (options.resume) {
      if (stableHash(await readJson(identityPath)) !== experimentHash) throw new Error('Resume experiment identity differs from saved dataset/config/prompt.');
    } else await writeFile(identityPath, JSON.stringify(identity, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
    const remaining: typeof cases = [];
    for (const c of cases) {
      const directory = join(output, c.id);
      let prior: unknown;
      try { prior = await readJson(join(directory, 'result.json')); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
      if (prior) {
        const run = validateCaseRun(prior, loaded.snapshots.get(c.id)!, config, evalPrompt(loaded.snapshots.get(c.id)!, options.promptMode), c.id);
        results.push(run); continue;
      }
      try { await readFile(join(directory, 'started.json')); throw new Error(`Interrupted model call for ${c.id}; use a new output directory for an explicit rerun.`); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
      remaining.push(c);
    }
    if (results.some(r => r.status === 'failed') && remaining.length) throw new Error('Prior provider failure stopped this experiment. Check login/usage and use a new output for an explicit rerun.');
    if (remaining.length * reviewers.length > options.maxCalls) throw new Error('Planned calls exceed --max-calls; reduce --limit or increase the explicit budget.');
    for (const c of remaining) {
      if (options.signal.aborted) break;
      const directory = join(output, c.id), snapshot = loaded.snapshots.get(c.id)!;
      await mkdir(directory, { recursive: true });
      await writeFile(join(directory, 'started.json'), JSON.stringify({ experimentHash, startedAt: new Date().toISOString() }) + '\n', { flag: 'wx', mode: 0o600 });
      options.progress?.(`${c.id}: starting ${reviewers.length} browser reviewer(s)`);
      const started = Date.now(), signal = AbortSignal.any([options.signal, AbortSignal.timeout(config.timeoutSeconds * 1000)]);
      const prompt = evalPrompt(snapshot, options.promptMode);
      const providers = await runReviewers({ reviewers, config, snapshot, prompt, directory, signal, adapter: options.adapter, progress: options.progress });
      const result: EvalCaseRun = { caseId: c.id, snapshotHash: c.snapshotHash, promptHash: stableHash(prompt), mode: 'live', providers,
        durationMs: Date.now() - started, status: providers.every(p => p.status === 'complete') ? 'complete' : providers.some(p => !p.result) ? 'failed' : 'partial' };
      await writeFile(join(directory, 'result.json'), JSON.stringify(result, null, 2) + '\n', { mode: 0o600 });
      results.push(result);
      // Stop on auth/quota/protocol failure instead of burning the remaining allowance.
      if (result.status === 'failed') break;
    }
    const summary = { experimentHash, identity, selected: cases.length, finished: results.length,
      failed: results.filter(r => r.status === 'failed').length, durationMs: results.reduce((n, r) => n + r.durationMs, 0),
      candidates: results.reduce((n, r) => n + evalCandidates(r).length, 0),
      scoring: 'pending-adjudication', actualBilledCost: null, results };
    await writeFile(join(output, 'run.json'), JSON.stringify(summary, null, 2) + '\n', { mode: 0o600 });
    return summary;
  } finally { await lock.close(); await rm(join(output, 'evaluation.lock')); }
}

const verdictSchema = z.strictObject({
  candidateId: digest, verdict: z.enum(['unjudged', 'true_positive', 'false_positive', 'duplicate', 'uncertain']),
  matchedIssueIds: z.array(id).max(100), duplicateOf: digest.nullable(), rationale: z.string().max(8000),
});
const judgementSchema = z.strictObject({
  schemaVersion: z.literal(1), runHash: digest, evaluator: z.enum(['pending', 'human', 'agent-assisted']),
  cases: z.array(z.strictObject({
    caseId: id, candidates: z.array(verdictSchema),
    issues: z.array(z.strictObject({ issueId: id, verdict: z.enum(['unjudged', 'found', 'missed', 'not_assessable']), rationale: z.string().max(8000) })),
  })),
});

export async function evaluationWorksheet(manifestPath: string, runPath: string, output: string) {
  const dataset = await loadEvaluation(manifestPath, true);
  const run = validateRun(await readJson(runPath), dataset);
  if (run.identity.datasetHash !== stableHash(dataset.manifest) || stableHash(run.identity) !== run.experimentHash) throw new Error('Run and dataset identities differ.');
  const cases = [];
  for (const result of run.results) {
    const c = dataset.manifest.cases.find(c => c.id === result.caseId);
    if (!c || result.snapshotHash !== c.snapshotHash) throw new Error('Run case differs from dataset.');
    const labels = evalLabelsSchema.parse(await readJson(await inside(dataset.root, c.labels)));
    cases.push({ caseId: c.id, status: result.status, source: c.source, labels,
      candidates: evalCandidates(result).map(c => ({ ...c, verdict: 'unjudged', matchedIssueIds: [], duplicateOf: null, rationale: '' })) });
  }
  await mkdir(output, { recursive: true });
  await writeFile(join(output, 'worksheet.json'), JSON.stringify({ runHash: stableHash(run), cases }, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
  const judgements = judgementSchema.parse({ schemaVersion: 1, runHash: stableHash(run), evaluator: 'pending', cases: cases.map(c => ({ caseId: c.caseId,
    candidates: c.candidates.map(({ id, verdict, matchedIssueIds, duplicateOf, rationale }) => ({ candidateId: id, verdict, matchedIssueIds, duplicateOf, rationale })),
    issues: c.labels.issues.map(i => ({ issueId: i.id, verdict: 'unjudged', rationale: '' })) })) });
  await writeFile(join(output, 'judgements.json'), JSON.stringify(judgements, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
  return judgements;
}

export async function scoreEvaluation(manifestPath: string, runPath: string, judgementsPath: string) {
  const dataset = await loadEvaluation(manifestPath, true), run = validateRun(await readJson(runPath), dataset);
  const judgements = judgementSchema.parse(await readJson(judgementsPath));
  if (run.identity.datasetHash !== stableHash(dataset.manifest) || stableHash(run.identity) !== run.experimentHash || judgements.runHash !== stableHash(run)) throw new Error('Judgements are stale or belong to another run.');
  if (judgements.cases.length !== run.results.length || new Set(judgements.cases.map(c => c.caseId)).size !== judgements.cases.length) throw new Error('Judgement cases are incomplete or duplicated.');
  const counts = { truePositive: 0, falsePositive: 0, duplicate: 0, uncertain: 0, unjudged: 0, knownFound: 0, knownMissed: 0, knownNotAssessable: 0, knownUnjudged: 0 };
  for (const result of run.results) {
    const c = dataset.manifest.cases.find(c => c.id === result.caseId), j = judgements.cases.find(j => j.caseId === result.caseId);
    if (!c || !j || result.snapshotHash !== c.snapshotHash) throw new Error('Judgements reference an unknown case.');
    const labels = evalLabelsSchema.parse(await readJson(await inside(dataset.root, c.labels)));
    const candidateIds = evalCandidates(result).map(c => c.id), issueIds = labels.issues.map(i => i.id);
    if (j.candidates.length !== candidateIds.length || new Set(j.candidates.map(c => c.candidateId)).size !== candidateIds.length || j.candidates.some(c => !candidateIds.includes(c.candidateId)) ||
        j.issues.length !== issueIds.length || new Set(j.issues.map(i => i.issueId)).size !== issueIds.length || j.issues.some(i => !issueIds.includes(i.issueId))) throw new Error('Every candidate and known issue needs exactly one judgement.');
    for (const v of j.candidates) {
      if (v.verdict !== 'unjudged' && !v.rationale.trim()) throw new Error('Judged findings require an evidence-backed rationale.');
      if (new Set(v.matchedIssueIds).size !== v.matchedIssueIds.length || v.matchedIssueIds.some(i => !issueIds.includes(i))) throw new Error('Unknown or duplicate matched issue.');
      if (v.verdict !== 'true_positive' && v.matchedIssueIds.length) throw new Error('Only a supported true positive can match a known issue.');
      if (v.verdict === 'duplicate') {
        if (!v.duplicateOf || v.duplicateOf === v.candidateId || !j.candidates.some(c => c.candidateId === v.duplicateOf && c.verdict === 'true_positive')) throw new Error('Duplicate must reference a supported finding in the same case.');
      } else if (v.duplicateOf) throw new Error('Only duplicates may reference another finding.');
      const field = { true_positive: 'truePositive', false_positive: 'falsePositive', duplicate: 'duplicate', uncertain: 'uncertain', unjudged: 'unjudged' } as const;
      counts[field[v.verdict]]++;
    }
    for (const i of j.issues) {
      const matched = j.candidates.some(c => c.verdict === 'true_positive' && c.matchedIssueIds.includes(i.issueId));
      if (i.verdict !== 'unjudged' && !i.rationale.trim()) throw new Error('Known issue verdicts require a rationale.');
      if ((i.verdict === 'found') !== matched) throw new Error('Found/missed issue judgement contradicts matched findings.');
      if (result.status === 'failed' && i.verdict === 'missed') throw new Error('Failed review cannot be scored as a successful miss; use not_assessable.');
      const field = { found: 'knownFound', missed: 'knownMissed', not_assessable: 'knownNotAssessable', unjudged: 'knownUnjudged' } as const;
      counts[field[i.verdict]]++;
    }
  }
  const ratio = (n: number, d: number) => d ? n / d : null;
  const complete = judgements.evaluator !== 'pending' && !counts.unjudged && !counts.knownUnjudged && run.finished === run.selected && !run.failed;
  return { status: complete ? 'adjudicated' : 'incomplete', evaluator: judgements.evaluator, runHash: stableHash(run), counts,
    // With pending judgements, reporting a percentage would reward selective annotation.
    actionablePrecision: complete && !counts.uncertain ? ratio(counts.truePositive, counts.truePositive + counts.falsePositive + counts.duplicate) : null,
    knownIssueRecall: complete && !counts.knownNotAssessable ? ratio(counts.knownFound, counts.knownFound + counts.knownMissed) : null,
    assessableKnownIssueRecall: complete ? ratio(counts.knownFound, counts.knownFound + counts.knownMissed) : null,
    duplicateRate: complete ? ratio(counts.duplicate, counts.truePositive + counts.falsePositive + counts.duplicate + counts.uncertain) : null,
    caveat: 'Known-issue recall is not exhaustive bug recall. Uncertain and not-assessable counts remain visible. Agent-assisted scoring is not human validation.' };
}
