import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Report } from './contracts.js';
import { normalize, renderNormalized } from './normalize.js';

function escape(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/[\\`*_\[\]#|]/g, '\\$&');
}

export function renderReport(report: Report): string {
  const lines = [
    '# PR review report', '',
    `**${report.mode.toUpperCase()} · ${report.status.toUpperCase()} · ${report.outcome}**`, '',
    `Run: ${report.runId}`, `Reviewers: ${report.providers.length}`, '',
    'This report covers only the supplied context. No tests were executed and no GitHub comments were posted.', '',
  ];
  if (report.snapshot) {
    const s = report.snapshot;
    lines.push(`PR: ${s.url}`, `Base: ${s.baseSha}`, `Head: ${s.headSha}`, `Merge base: ${s.mergeBaseSha}`, '',
      `Included changed files: ${s.files.filter(f => f.kind === 'change').length}/${s.totalChangedFiles}`, '',
      '## Coverage exclusions', '', ...s.exclusions.map(e => `- ${escape(e.path)}: ${escape(e.reason)}`));
    if (!s.exclusions.length) lines.push('None within the configured changed-file scope.');
  }
  lines.push('', '## Findings', '');
  for (const p of report.providers) {
    lines.push(`## Reviewer: ${escape(p.name)} · ${p.status}`, '',
      `CLI: ${escape(p.version ?? 'unavailable')}`, `Requested model: ${escape(p.requestedModel ?? 'none')}`,
      `Reported model: ${escape(p.model ?? 'not exposed by provider')}`, `Runtime: ${p.durationMs} ms`, '',
      `Context hash: ${p.contextHash}`, `Prompt hash: ${p.promptHash}`, '');
    if (p.errors.length) lines.push(...p.errors.map(e => `- ${escape(e)}`), '');
    if (!p.result) { lines.push('No valid review result is available.', ''); continue; }
    lines.push(escape(p.result.summary), '');
    for (const f of p.result.findings) lines.push(
      `### ${escape(f.severity.toUpperCase())}: ${escape(f.title)}`, '',
      `${escape(f.path)}:${f.line} (${f.side})`, '', escape(f.description), '',
      `Trigger: ${escape(f.trigger)}`, '', `Impact: ${escape(f.impact)}`, '', `Evidence: ${escape(f.evidence)}`, '',
    );
    lines.push('### Limitations', '', ...p.result.limitations.map(l => `- ${escape(l)}`), '');
  }
  if (!report.providers.length) lines.push('No valid review result is available.');
  if (report.errors.length) lines.push('', '## Errors', '', ...report.errors.map(e => `- ${escape(e)}`));
  lines.push('', renderNormalized(normalize(report)));
  return lines.join('\n') + '\n';
}

export async function saveReport(directory: string, report: Report): Promise<void> {
  await writeFile(join(directory, 'report.json'), JSON.stringify(report, null, 2) + '\n', { mode: 0o600 });
  await writeFile(join(directory, 'report.md'), renderReport(report), { mode: 0o600 });
  await writeFile(join(directory, 'normalized-findings.json'), JSON.stringify(normalize(report), null, 2) + '\n', { mode: 0o600 });
}
