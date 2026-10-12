import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { configSchema, repoPath, type Config, type ReviewFile, type Snapshot } from './contracts.js';
import { parseRawDiff } from './diff.js';
import { getPr } from './github.js';
import { baseEnvironment, ProcessError, run } from './process.js';

export function gitEnvironment(token?: string): NodeJS.ProcessEnv {
  return {
    ...baseEnvironment(),
    GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: process.platform === 'win32' ? 'NUL' : '/dev/null',
    GIT_TERMINAL_PROMPT: '0', GIT_CONFIG_COUNT: token ? '2' : '1',
    GIT_CONFIG_KEY_0: 'credential.helper', GIT_CONFIG_VALUE_0: '',
    ...(token ? { GIT_CONFIG_KEY_1: 'http.https://github.com/.extraheader', GIT_CONFIG_VALUE_1: `AUTHORIZATION: basic ${Buffer.from(`x-access-token:${token}`).toString('base64')}` } : {}),
  };
}

export function limitSnapshot(snapshot: Snapshot, config: Config): Snapshot {
  configSchema.parse(config);
  const files: ReviewFile[] = [];
  const exclusions = [...snapshot.exclusions];
  let used = Buffer.byteLength(snapshot.title + snapshot.body);
  for (const file of snapshot.files) {
    let reason: string | undefined;
    const bytes = Buffer.byteLength(JSON.stringify(file));
    if (files.length >= config.maxFiles) reason = 'File count limit';
    else if ([file.before, file.after].some(s => s !== null && Buffer.byteLength(s) > config.maxFileBytes)) reason = 'File size limit';
    else if (used + bytes > config.maxContextBytes) reason = 'Context byte limit';
    if (reason) exclusions.push({ path: file.path, reason });
    else { files.push(file); used += bytes; }
  }
  return { ...snapshot, files, exclusions };
}

export async function readGitSnapshot(
  repo: string, baseSha: string, headSha: string, config: Config, signal: AbortSignal,
): Promise<Pick<Snapshot, 'mergeBaseSha' | 'files' | 'exclusions' | 'totalChangedFiles'>> {
  const git = (args: string[], maxBytes = 8_000_000) => run('git', ['--git-dir', repo, ...args], { signal, env: gitEnvironment(), maxBytes });
  const mergeBaseSha = (await git(['merge-base', baseSha, headSha])).trim();
  if (!/^[0-9a-f]{40}$/.test(mergeBaseSha)) throw new Error('Cannot establish a merge base for this PR.');
  const raw = await git(['diff', '--raw', '-z', '--no-abbrev', '--find-renames', mergeBaseSha, headSha]);
  const changes = parseRawDiff(raw);
  const files: ReviewFile[] = [];
  const exclusions: Snapshot['exclusions'] = [];
  let bytesUsed = 0;
  const blob = async (oid: string, mode: string): Promise<string | null> => {
    if (/^0+$/.test(oid)) return null;
    if (!['100644', '100755'].includes(mode)) throw new Error('Symlink, submodule, or unsupported file mode');
    const size = Number((await git(['cat-file', '-s', oid])).trim());
    if (!Number.isSafeInteger(size) || size > config.maxFileBytes) throw new Error('File size limit');
    const text = await git(['cat-file', 'blob', oid], config.maxFileBytes + 1024);
    if (text.includes('\0') || text.includes('\uFFFD')) throw new Error('Binary or unsupported text encoding');
    return text;
  };
  for (const change of changes) {
    if (signal.aborted) throw new ProcessError('cancelled', 'Snapshot cancelled or deadline exceeded.');
    try {
      repoPath.parse(change.path);
      if (change.previousPath) repoPath.parse(change.previousPath);
    } catch { exclusions.push({ path: change.path, reason: 'Unsupported repository path' }); continue; }
    if (files.length >= config.maxFiles) { exclusions.push({ path: change.path, reason: 'File count limit' }); continue; }
    try {
      const before = await blob(change.oldOid, change.oldMode);
      const after = await blob(change.newOid, change.newMode);
      const paths = change.previousPath ? [change.previousPath, change.path] : [change.path];
      const patch = await git(['diff', '--no-ext-diff', '--no-textconv', '--no-color', '--find-renames', '--unified=3', mergeBaseSha, headSha, '--', ...paths], config.maxFileBytes * 3 + 16_384);
      const file: ReviewFile = { path: change.path, previousPath: change.previousPath, status: change.status, before, after, patch, kind: 'change' };
      const bytes = Buffer.byteLength(JSON.stringify(file));
      if (bytesUsed + bytes > config.maxContextBytes) throw new Error('Context byte limit');
      files.push(file); bytesUsed += bytes;
    } catch (error) {
      if (error instanceof ProcessError && error.code !== 'output_limit') throw error;
      exclusions.push({ path: change.path, reason: error instanceof Error ? error.message : 'Unable to read file' });
    }
  }
  for (const path of config.contextFiles) {
    if (files.some(f => f.path === path)) continue;
    if (files.length >= config.maxFiles) { exclusions.push({ path, reason: 'File count limit' }); continue; }
    try {
      const listing = await git(['ls-tree', '-z', headSha, '--', path]);
      const entry = /^(\d{6}) blob ([0-9a-f]{40})\t([^\0]+)\0$/.exec(listing);
      if (!entry || entry[3] !== path) throw new Error('Context file is absent or is not a regular file');
      const after = await blob(entry[2]!, entry[1]!);
      const file: ReviewFile = { path, previousPath: null, status: 'context', patch: '', before: null, after, kind: 'context' };
      const bytes = Buffer.byteLength(JSON.stringify(file));
      if (bytesUsed + bytes > config.maxContextBytes) throw new Error('Context byte limit');
      files.push(file); bytesUsed += bytes;
    } catch (error) {
      if (error instanceof ProcessError && error.code !== 'output_limit') throw error;
      exclusions.push({ path, reason: error instanceof Error ? error.message : 'Unable to read context' });
    }
  }
  return { mergeBaseSha, files, exclusions, totalChangedFiles: changes.length };
}

export async function capturePr(url: string, token: string, directory: string, config: Config, signal: AbortSignal): Promise<Snapshot> {
  const metadata = await getPr(url, token, signal);
  const repository = metadata.base.repo.full_name;
  if (!/^[\w.-]+\/[\w.-]+$/.test(repository)) throw new Error('Unsupported GitHub repository identity.');
  const bare = join(directory, 'snapshot.git');
  await mkdir(bare, { recursive: true });
  await run('git', ['init', '--bare', bare], { signal, env: gitEnvironment() });
  // No checkout, hooks, filters, submodules, external diff, or repository scripts.
  // Fetch exact captured SHAs rather than a mutable branch or GitHub merge ref.
  await run('git', ['--git-dir', bare, 'fetch', '--no-tags', '--no-write-fetch-head', `https://github.com/${repository}.git`, metadata.base.sha, metadata.head.sha], { signal, env: gitEnvironment(token) });
  const content = await readGitSnapshot(bare, metadata.base.sha, metadata.head.sha, config, signal);
  const exclusions = [...content.exclusions];
  if (content.totalChangedFiles !== metadata.changed_files) exclusions.push({ path: '(snapshot)', reason: 'GitHub changed-file count differs from captured Git comparison' });
  const title = metadata.title.slice(0, 1000);
  const body = (metadata.body ?? '').slice(0, 20_000);
  if (title !== metadata.title || body !== (metadata.body ?? '')) exclusions.push({ path: '(PR metadata)', reason: 'Metadata length limit' });
  return limitSnapshot({
    repository, pr: metadata.number, url: metadata.html_url, title, body,
    baseSha: metadata.base.sha, headSha: metadata.head.sha, ...content, exclusions,
  }, config);
}
