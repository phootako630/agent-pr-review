import type { Report } from './contracts.js';
import { escapeMarkdown as escape, normalize, type Normalized } from './normalize.js';
import { stableHash } from './report-input.js';

export type Policy = { allowPartial: boolean; maxComments: number };
export type PlannedComment = { fingerprint: string; marker: string; path: string; side: 'LEFT' | 'RIGHT'; line: number; body: string };
export type PublicationPlan = {
  schemaVersion: 1; publicationId: string; reportHash: string; policyHash: string; snapshotKey: string;
  target: { repository: string; pr: number; url: string; headSha: string; baseSha: string; mergeBaseSha: string };
  summaryMarker: string; summary: string; comments: PlannedComment[]; normalized: Normalized; policy: Policy;
};
const oneLine = (s: string, max = 240) => escape(s.replace(/[\r\n]+/g, ' ').slice(0, max));

export function publicationPlan(report: Report, policy: Policy): PublicationPlan {
  if (!Number.isInteger(policy.maxComments) || policy.maxComments < 1 || policy.maxComments > 50) throw new Error('maxComments must be 1–50.');
  if (report.mode !== 'live' || !report.snapshot || !['complete', 'partial'].includes(report.status)) throw new Error('Only a completed live review can be published. Simulation, failed, and cancelled reports are refused.');
  if (report.status === 'partial' && !policy.allowPartial) throw new Error('Report is partial. Inspect limitations and opt in with --allow-partial to publish it.');
  const s = report.snapshot;
  const target = { repository: s.repository, pr: s.pr, url: s.url, headSha: s.headSha, baseSha: s.baseSha, mergeBaseSha: s.mergeBaseSha };
  const snapshotKey = stableHash(target), reportHash = stableHash(report), policyHash = stableHash({ version: 1, ...policy });
  const publicationId = stableHash({ reportHash, policyHash, snapshotKey });
  const summaryMarker = `<!-- agent-pr-review:v1 run=${publicationId} -->`;
  const normalized = normalize(report);
  const inline = normalized.candidates.filter(c => c.disposition === 'inline');
  for (const c of inline.slice(policy.maxComments)) { c.disposition = 'held'; c.reasons.push('Inline comment budget exceeded; retained for inspection.'); }
  const comments = inline.slice(0, policy.maxComments).map(c => {
    const f = c.finding;
    const marker = `<!-- agent-pr-review:v1 finding=${c.id} snapshot=${snapshotKey} -->`;
    return { fingerprint: c.id, marker, path: f.path, side: f.side, line: f.line,
      body: [`**${f.severity.toUpperCase()}: ${oneLine(f.title)}**`, '', escape(f.description), '',
        `Trigger: ${escape(f.trigger)}`, '', `Impact: ${escape(f.impact)}`, '', 'Source evidence:',
        ...f.evidence.split('\n').map(line => `> ${escape(line)}`), '',
        `Reviewer sources: ${c.origins.map(o => `${o.provider} (${oneLine(o.model ?? 'model not reported', 100)})`).join(', ')}.`,
        `Reviewed head: ${s.headSha}. No tests were run by this review.`, '', marker].join('\n') };
  });
  const held = normalized.candidates.filter(c => c.disposition === 'held');
  const summary = [
    '**Agent PR Review — comment-only review**', '',
    `Reviewed head: ${s.headSha}`, `Base: ${s.baseSha}`, `Merge base: ${s.mergeBaseSha}`, '',
    `Coverage: ${report.status.toUpperCase()}; ${s.files.filter(f => f.kind === 'change').length}/${s.totalChangedFiles} changed files supplied.`,
    `Inline findings: ${comments.length}; held for inspection: ${held.length}. Agreement alone is not evidence.`, '',
    'This review covers the supplied packet. It does not approve the PR, authorize rework, or claim tests were executed.', '',
    '### Reviewers',
    ...report.providers.map(p => `- ${p.name}: ${p.status}; requested ${oneLine(p.requestedModel ?? 'none', 100)}, reported ${oneLine(p.model ?? 'not exposed', 100)}, CLI ${oneLine(p.version ?? 'unavailable', 100)}.`), '',
    '### Limitations and coverage',
    ...report.providers.flatMap(p => [...(p.result?.limitations ?? []), ...p.errors].slice(0, 10).map(l => `- ${p.name}: ${oneLine(l, 500)}`)),
    ...s.exclusions.slice(0, 20).map(e => `- ${oneLine(e.path)}: ${oneLine(e.reason, 300)}`), '',
    '### Held candidates',
    ...held.slice(0, 20).map(c => `- ${oneLine(c.finding.title, 160)} — ${oneLine(c.finding.path, 120)}:${c.finding.line} (${c.finding.side}); ${c.origins.map(o => o.provider).join(', ')}. ${oneLine(c.reasons.join(' '), 300)} Claim: ${oneLine(c.finding.description, 160)} Trigger: ${oneLine(c.finding.trigger, 160)} Impact: ${oneLine(c.finding.impact, 160)}`),
    ...(held.length > 20 ? [`- ${held.length - 20} additional held candidates are retained in the local publication plan.`] : []),
    ...(held.length ? [] : ['None.']), '',
    ...(normalized.conflictAnchors.length ? ['Different claims at shared anchors are held as potential conflicts or separate defects for human inspection; no semantic contradiction is inferred.'] : []),
    `Publication: ${publicationId}`, summaryMarker,
  ].join('\n');
  if (summary.length > 60_000 || comments.some(c => c.body.length > 60_000)) throw new Error('Publication text exceeds the supported GitHub body limit.');
  return { schemaVersion: 1, publicationId, reportHash, policyHash, snapshotKey, target, summaryMarker, summary, comments, normalized, policy };
}

export function renderPreview(plan: PublicationPlan): string {
  return [plan.summary, '', '---', '', ...plan.comments.flatMap(c => [
    `### Planned inline comment: ${escape(c.path)}:${c.line} (${c.side})`, '', c.body, '',
  ])].join('\n') + '\n';
}
