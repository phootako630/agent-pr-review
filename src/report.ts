import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Report } from './contracts.js';

function escape(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/[\\`*_\[\]#|]/g, '\\$&');
}

export function renderReport(report: Report): string {
  const lines = [
    '# PR review report', '',
    `**${report.mode.toUpperCase()} · ${report.status.toUpperCase()} · ${report.outcome}**`, '',
    `Run: ${report.runId}`, `Provider: ${escape(report.provider.name)} (${escape(report.provider.version ?? 'unknown')})`,
    `Model: ${escape(report.provider.model ?? 'provider default; not reported')}`, '',
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
  if (report.result) {
    lines.push(escape(report.result.summary), '');
    for (const f of report.result.findings) lines.push(
      `### ${escape(f.severity.toUpperCase())}: ${escape(f.title)}`, '',
      `${escape(f.path)}:${f.line} (${f.side})`, '', escape(f.description), '',
      `Trigger: ${escape(f.trigger)}`, '', `Impact: ${escape(f.impact)}`, '', `Evidence: ${escape(f.evidence)}`, '',
    );
    lines.push('## Limitations', '', ...report.result.limitations.map(l => `- ${escape(l)}`));
  } else lines.push('No valid review result is available.');
  if (report.errors.length) lines.push('', '## Errors', '', ...report.errors.map(e => `- ${escape(e)}`));
  return lines.join('\n') + '\n';
}

export async function saveReport(directory: string, report: Report): Promise<void> {
  await writeFile(join(directory, 'report.json'), JSON.stringify(report, null, 2) + '\n', { mode: 0o600 });
  await writeFile(join(directory, 'report.md'), renderReport(report), { mode: 0o600 });
}
