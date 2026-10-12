import { repoPath, type ReviewResult, type Snapshot } from './contracts.js';

export type Change = { oldMode: string; newMode: string; oldOid: string; newOid: string; status: string; path: string; previousPath: string | null };
export function parseRawDiff(raw: string): Change[] {
  const parts = raw.split('\0');
  const changes: Change[] = [];
  for (let i = 0; i < parts.length - 1;) {
    const header = parts[i++]!;
    const match = /^:(\d{6}) (\d{6}) ([0-9a-f]{40}) ([0-9a-f]{40}) ([A-Z]\d*)$/.exec(header);
    if (!match) throw new Error('Invalid raw Git diff.');
    const first = parts[i++];
    if (first === undefined) throw new Error('Missing diff path.');
    const renamed = /^[RC]/.test(match[5]!);
    const path = renamed ? parts[i++] : first;
    if (path === undefined) throw new Error('Missing rename destination.');
    changes.push({ oldMode: match[1]!, newMode: match[2]!, oldOid: match[3]!, newOid: match[4]!, status: match[5]!, path, previousPath: renamed ? first : null });
  }
  return changes;
}

export function diffAnchors(patch: string): { LEFT: Set<number>; RIGHT: Set<number> } {
  const anchors = { LEFT: new Set<number>(), RIGHT: new Set<number>() };
  let old = 0, next = 0, oldRemaining = 0, newRemaining = 0;
  for (const line of patch.split('\n')) {
    const hunk = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(line);
    if (hunk) {
      old = Number(hunk[1]); next = Number(hunk[3]);
      oldRemaining = hunk[2] === undefined ? 1 : Number(hunk[2]);
      newRemaining = hunk[4] === undefined ? 1 : Number(hunk[4]);
      continue;
    }
    if (line.startsWith('-') && oldRemaining > 0) { anchors.LEFT.add(old++); oldRemaining--; }
    else if (line.startsWith('+') && newRemaining > 0) { anchors.RIGHT.add(next++); newRemaining--; }
    else if (line.startsWith(' ') && oldRemaining > 0 && newRemaining > 0) {
      anchors.LEFT.add(old++); anchors.RIGHT.add(next++); oldRemaining--; newRemaining--;
    }
  }
  return anchors;
}

export function validateFindings(result: ReviewResult, snapshot: Snapshot): ReviewResult {
  const findings: ReviewResult['findings'] = [];
  const limitations = [...result.limitations];
  for (const finding of result.findings) {
    repoPath.parse(finding.path);
    const file = snapshot.files.find(f => f.kind === 'change' && f.path === finding.path);
    const source = finding.side === 'LEFT' ? file?.before : file?.after;
    const valid = file && source && diffAnchors(file.patch)[finding.side].has(finding.line) && source.includes(finding.evidence);
    if (valid) findings.push(finding);
    else limitations.push(`Rejected finding "${finding.title}": invalid diff anchor or evidence absent from the supplied source.`);
  }
  return { ...result, findings, limitations };
}
