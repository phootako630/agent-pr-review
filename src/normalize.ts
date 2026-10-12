import type { Report, ReviewResult } from './contracts.js';
import { validateFindings } from './diff.js';
import { stableHash } from './report-input.js';

export type Finding = ReviewResult['findings'][number];
export type Origin = { provider: string; candidate: number; model: string | null; version: string | null };
export type Candidate = { id: string; finding: Finding; origins: Origin[]; disposition: 'inline' | 'held'; reasons: string[] };
export type Normalized = { schemaVersion: 1; candidates: Candidate[]; conflictAnchors: string[] };
const priorities = { critical: 0, high: 1, medium: 2, low: 3 };
const prose = (s: string) => s.trim();
function supportedClaim(s: string): boolean {
  return s.trim().length >= 10 && !/^(?:n\/?a|none|unknown|todo|tbd|unspecified|not provided|needs? investigation)[.!\s]*$/i.test(s.trim());
}

export function normalize(report: Report): Normalized {
  if (!report.snapshot) return { schemaVersion: 1, candidates: [], conflictAnchors: [] };
  const groups = new Map<string, Candidate>();
  for (const p of report.providers) {
    if (!p.rawResult || !['complete', 'partial'].includes(p.status)) continue;
    for (const [index, finding] of p.rawResult.findings.entries()) {
      // No fuzzy title matching or majority-vote inference. Different anchors never merge.
      const id = stableHash({ repository: report.snapshot.repository.toLowerCase(), pr: report.snapshot.pr,
        path: finding.path, side: finding.side, line: finding.line, evidence: finding.evidence,
        description: prose(finding.description), trigger: prose(finding.trigger), impact: prose(finding.impact) });
      const origin = { provider: p.name, candidate: index, model: p.model, version: p.version };
      const existing = groups.get(id);
      if (existing) {
        existing.origins.push(origin);
        if (priorities[finding.severity] < priorities[existing.finding.severity]) existing.finding.severity = finding.severity;
        continue;
      }
      const reasons: string[] = [];
      if (!validateFindings({ summary: 'Evidence check', findings: [finding], limitations: [] }, report.snapshot).findings.length) reasons.push('Invalid diff anchor or source evidence; no inline location will be fabricated.');
      if (!supportedClaim(finding.description) || !supportedClaim(finding.trigger) || !supportedClaim(finding.impact)) reasons.push('A specific defect, concrete trigger, and observable impact are required; placeholder claims are held.');
      groups.set(id, { id, finding: { ...finding }, origins: [origin], disposition: reasons.length ? 'held' : 'inline', reasons });
    }
  }
  const anchors = new Map<string, Candidate[]>();
  for (const candidate of groups.values()) {
    if (candidate.disposition !== 'inline') continue;
    const f = candidate.finding, anchor = `${f.path}:${f.side}:${f.line}`;
    anchors.set(anchor, [...(anchors.get(anchor) ?? []), candidate]);
  }
  const conflictAnchors: string[] = [];
  for (const [anchor, candidates] of anchors) {
    if (candidates.length < 2) continue;
    conflictAnchors.push(anchor);
    for (const c of candidates) {
      c.disposition = 'held';
      c.reasons.push('Different claims share this anchor: potential conflict or separate defects. Human inspection is required; this is not a semantic contradiction verdict.');
    }
  }
  const candidates = [...groups.values()].sort((a, b) => priorities[a.finding.severity] - priorities[b.finding.severity] || a.id.localeCompare(b.id));
  return { schemaVersion: 1, candidates, conflictAnchors: conflictAnchors.sort() };
}

export function escapeMarkdown(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/@/g, '&#64;').replace(/[\\`*_\[\]#|]/g, '\\$&');
}
export function renderNormalized(normalized: Normalized): string {
  const lines = ['## Evidence filtering', '', `Conservative groups: ${normalized.candidates.length}; held: ${normalized.candidates.filter(c => c.disposition === 'held').length}.`, '',
    'Only identical claims at the same source anchor are combined. Different claims sharing an anchor are held for human inspection.', ''];
  for (const c of normalized.candidates) lines.push(`- ${c.disposition.toUpperCase()}: ${escapeMarkdown(c.finding.title)} (${escapeMarkdown(c.finding.path)}:${c.finding.line}, ${c.finding.side}); sources: ${c.origins.map(o => o.provider).join(', ')}`,
    ...c.reasons.map(r => `  ${escapeMarkdown(r)}`));
  return lines.join('\n') + '\n';
}
