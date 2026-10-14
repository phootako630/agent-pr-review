// Read data and immutable Git objects only. Never checks out code or executes dataset scripts.
import { mkdir, readFile, writeFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { Octokit } from '@octokit/rest';
import { snapshotSchema } from '../dist/contracts.js';
import { stableHash } from '../dist/report-input.js';
import { gitEnvironment } from '../dist/snapshot.js';
import { githubToken } from '../dist/github.js';
import { evalManifestSchema, evalLabelsSchema } from '../dist/evaluation.js';
import { diffAnchors } from '../dist/diff.js';

async function main() {
const output = resolve(process.argv[2] ?? '.pr-review/eval/pilot-v1-windowed');
const selection = JSON.parse(await readFile(new URL('../eval/reviewbench-selection.json', import.meta.url), 'utf8'));
const synthetic = JSON.parse(await readFile(new URL('../eval/synthetic.json', import.meta.url), 'utf8'));
const rawRoot = `https://raw.githubusercontent.com/review-bench/ReviewBench/${selection.revision}`;
const signal = AbortSignal.timeout(600_000);
const octokit = new Octokit({ auth: await githubToken(signal), request: { signal } });
const exec = promisify(execFile);
let frozen;
try { frozen = evalManifestSchema.parse(JSON.parse(await readFile(new URL('../eval/pilot-v1-windowed.lock.json', import.meta.url), 'utf8'))); }
catch (error) { if (error.code !== 'ENOENT') throw error; }
await mkdir(output, { recursive: true });
const cases = [];
async function text(url, optional = false) {
  const r = await fetch(url, { signal });
  if (optional && r.status === 404) return null;
  if (!r.ok) throw new Error(`Dataset download failed: HTTP ${r.status}`);
  const body = await r.text();
  if (Buffer.byteLength(body) > 8_000_000) throw new Error('Dataset object exceeds size limit.');
  return body;
}
async function jsonFile(path, value) { await writeFile(path, JSON.stringify(value, null, 2) + '\n'); }
async function diff(before, after) {
  const dir = await mkdtemp(join(tmpdir(), 'review-eval-diff-'));
  try {
    const left = join(dir, 'before'), right = join(dir, 'after');
    await writeFile(left, before ?? ''); await writeFile(right, after ?? '');
    const args = ['diff', '--no-index', '--no-ext-diff', '--no-textconv', '--no-color', '--unified=3', '--', left, right];
    let patch;
    try { patch = (await exec('git', args, { env: gitEnvironment(), maxBuffer: 8_000_000 })).stdout; }
    catch (error) {
      if (error.code === 1 && typeof error.stdout === 'string' && error.stdout.includes('@@')) patch = error.stdout;
      else throw new Error('Unable to construct immutable source diff.');
    }
    // Temporary absolute paths must never affect the frozen packet identity.
    let inHunk = false;
    return patch.split('\n').map(line => {
      if (line.startsWith('@@')) inHunk = true;
      if (inHunk) return line;
      return line.startsWith('diff --git ') ? 'diff --git a/source b/source'
        : line.startsWith('--- ') ? '--- a/source' : line.startsWith('+++ ') ? '+++ b/source' : line;
    }).join('\n');
  } finally { await rm(dir, { recursive: true, force: true }); }
}
async function saveCase(item, snapshot, labels) {
  snapshot = snapshotSchema.parse(snapshot);
  const snapshotHash = stableHash(snapshot);
  labels = evalLabelsSchema.parse({ ...labels, caseId: item.id, snapshotHash });
  if (frozen) {
    const expected = frozen.cases.find(c => c.id === item.id);
    if (!expected || expected.snapshotHash !== snapshotHash || expected.labelsHash !== stableHash(labels)) throw new Error(`Prepared case differs from frozen lock: ${item.id}`);
  }
  const snapshotPath = `inputs/${item.id}.json`, labelsPath = `labels/${item.id}.json`;
  await jsonFile(join(output, snapshotPath), snapshot); await jsonFile(join(output, labelsPath), labels);
  cases.push({ ...item, snapshot: snapshotPath, snapshotHash, labels: labelsPath, labelsHash: stableHash(labels) });
}
// Retain original line numbers for source evidence. Empty lines outside windows
// are unavailable text, not a claim about actual source; disclose this in exclusions.
function windowed(source, anchors) {
  if (source === null) return null;
  const retained = new Set();
  for (const line of anchors) for (let n = Math.max(1, line - 20); n <= line + 20; n++) retained.add(n);
  return source.split('\n').map((line, index) => retained.has(index + 1) ? line : '').join('\n');
}
for (const path of ['inputs', 'labels', 'upstream', 'notices']) await mkdir(join(output, path), { recursive: true });
const manifest = JSON.parse(await text(`${rawRoot}/corpus/manifest.json`));
await writeFile(join(output, 'notices', 'ReviewBench-LICENSE'), await text(`${rawRoot}/LICENSE`));
await jsonFile(join(output, 'upstream', 'selection.json'), selection);
for (const [index, pick] of selection.samples.entries()) {
  const id = `public-${String(index + 1).padStart(2, '0')}`;
  const upstream = manifest.find(c => c.nwo === pick.nwo && c.pr_number === pick.pr_number && c.head === pick.head && c.base === pick.base);
  if (!upstream) throw new Error('Selected case is absent from pinned source manifest.');
  const mirror = pick.mirror.replace('https://github.com/', '');
  console.error(`${id}: ${pick.nwo}#${pick.pr_number} @ ${pick.head.slice(0, 8)}`);
  const { data: comparison } = await octokit.repos.compareCommitsWithBasehead({ owner: 'review-bench', repo: mirror.split('/')[1], basehead: `${pick.base}...${pick.head}`, per_page: 1 });
  if (!comparison.files?.length || comparison.files.length >= 300) throw new Error('Captured comparison has incomplete changed-file coverage.');
  const mergeBaseSha = comparison.merge_base_commit.sha;
  const files = [], exclusions = [];
  if (comparison.files.length !== pick.files_changed) exclusions.push({ path: '(upstream metadata)', reason: `Manifest states ${pick.files_changed} files; immutable Git comparison contains ${comparison.files.length}. Historical comparison is authoritative.` });
  const blob = async (sha, path) => text(`https://raw.githubusercontent.com/${mirror}/${sha}/${path.split('/').map(encodeURIComponent).join('/')}`);
  for (const f of comparison.files) {
    try {
      const before = f.status === 'added' ? null : await blob(mergeBaseSha, f.previous_filename ?? f.filename);
      const after = f.status === 'removed' ? null : await blob(pick.head, f.filename);
      if ([before, after].some(s => s !== null && (Buffer.byteLength(s) > 1_000_000 || s.includes('\0') || s.includes('\uFFFD')))) throw new Error('File exceeds source limits or is not supported text.');
      const patch = await diff(before, after), anchors = diffAnchors(patch);
      files.push({ path: f.filename, previousPath: f.previous_filename ?? null, status: f.status,
        before: windowed(before, anchors.LEFT), after: windowed(after, anchors.RIGHT), patch, kind: 'change' });
    } catch (error) { exclusions.push({ path: f.filename, reason: error.message }); }
  }
  // Preserve root source-license notices in the local cache, without executing repository code.
  for (const licensePath of ['LICENSE', 'LICENSE.txt', 'LICENSE.md', 'COPYING']) {
    const notice = await text(`https://raw.githubusercontent.com/${mirror}/${pick.head}/${licensePath}`, true);
    if (notice) await writeFile(join(output, 'notices', `${id}-${licensePath}`), notice);
  }
  const golden = JSON.parse(await text(pick.golden_url));
  if (golden.pr.base !== pick.base || golden.pr.head !== pick.head || golden.pr.pr_number !== pick.pr_number || golden.pr.repo !== pick.repo) throw new Error('Golden snapshot does not match source selection.');
  await jsonFile(join(output, 'upstream', `${id}-golden.json`), golden);
  const labels = golden.findings.filter(f => f.tp_fp === 'tp' && ['introduced-by-pr', 'exacerbated-by-pr'].includes(f.scope) && ['correctness', 'reliability', 'security', 'performance'].includes(f.category));
  await saveCase({ id, group: id, split: index < 6 ? 'dev' : 'test', language: pick.language,
    source: { kind: 'public', url: pick.pr_url, revision: selection.revision, license: 'ReviewBench MIT; source repository licenses retained in local notices' } },
    { repository: pick.nwo, pr: pick.pr_number, url: pick.pr_url, title: upstream.title, body: '', baseSha: pick.base, headSha: pick.head, mergeBaseSha,
      totalChangedFiles: comparison.files.length, files, exclusions: [...exclusions,
        { path: '(source context)', reason: 'Only diff hunks plus 20 surrounding lines are supplied. Blank lines outside these windows represent omitted source, preserving original line numbers; do not infer their contents.' },
        { path: '(metadata)', reason: 'PR body omitted to avoid mutable post-review discussion; only original manifest title retained.' }] },
    { provenance: 'upstream-reference', completeness: 'known-issues-only',
      issues: labels.map((f, i) => ({ id: `reference-${i + 1}`, description: f.message,
        evidence: `${f.file}:${f.start_line}-${f.end_line}; ${f.category}; ${f.scope}; context=${f.context_required}. ${f.tp_fp_justification}` })),
      notes: `Reference slice: tp, introduced/exacerbated, correctness/reliability/security/performance. Retained ${labels.length}/${golden.findings.length} source findings. Zero retained labels is NOT a clean-PR assertion. Source labels require adjudication under our rubric. Full reference is in upstream/${id}-golden.json. Packet has changed files only; no dependency or test execution.` });
}
for (const [index, fixture] of synthetic.entries()) {
  const sourceRevision = stableHash(fixture), sha = n => sourceRevision.slice(0, 39) + n;
  await saveCase({ id: fixture.id, group: fixture.group, split: fixture.split, language: 'JavaScript',
    source: { kind: 'synthetic', url: 'https://github.com/phootako630/agent-pr-review', revision: sourceRevision, license: 'Project-authored evaluation fixture' } },
    { repository: 'synthetic/evaluation', pr: index + 1, url: `https://github.com/synthetic/evaluation/pull/${index + 1}`,
      title: 'Review a coordinator change', body: fixture.intent, baseSha: sha('0'), headSha: sha('1'), mergeBaseSha: sha('0'), totalChangedFiles: 1,
      files: [{ path: 'coordinator.js', previousPath: null, status: 'modified', kind: 'change', before: fixture.before, after: fixture.after, patch: await diff(fixture.before, fixture.after) }], exclusions: [] },
    { provenance: 'curated-fixture', completeness: 'exhaustive-fixture', issues: fixture.issues, notes: 'Project-authored small fixture under its stated contract. This is an author annotation, not independent human validation or a real production PR.' });
}
const result = evalManifestSchema.parse({ schemaVersion: 1, datasetId: 'pilot-v1-windowed', description: '10 pinned public ReviewBench tasks (diff + 20-line neighborhoods) + 10 original coordinator fixtures; 12 dev, 8 reserved test; no few-shots. Not an official ReviewBench score.', cases });
if (frozen && stableHash(frozen) !== stableHash(result)) throw new Error('Prepared manifest differs from frozen lock.');
await jsonFile(join(output, 'manifest.json'), result);
console.log(`${output}/manifest.json: ${cases.length} cases prepared; no model calls or GitHub writes.`);
}
main().catch(() => {
  // GitHub errors can contain request metadata; never print an exception object.
  console.error('Dataset preparation failed. Check read access, source availability, supported sizes, and frozen input hashes. No model calls or GitHub writes.');
  process.exitCode = 1;
});
