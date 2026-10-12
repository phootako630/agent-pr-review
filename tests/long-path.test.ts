import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { run } from '../src/process.js';
import { gitEnvironment } from '../src/snapshot.js';

test('freshness capture Git fetch works in deep journal paths on Windows', async () => {
  const root = await mkdtemp(join(tmpdir(), 'deep-git-'));
  const source = join(root, 'source');
  // Keep GIT_DIR below Git's own explicit-dir limit while object paths exceed MAX_PATH.
  const first = 'x'.repeat(80);
  const second = 'y'.repeat(Math.max(1, 210 - join(root, first, 'snapshot.git').length - 1));
  const bare = join(root, first, second, 'snapshot.git');
  const env = gitEnvironment();
  const git = async (args: string[], cwd?: string) => {
    try { return await run('git', args, { env, cwd }); }
    catch (error) { throw new Error(`Deep-path Git ${args[0]} failed: ${error instanceof Error ? error.message : 'unknown'}`); }
  };
  try {
    await mkdir(source); await git(['init', source]);
    await writeFile(join(source, 'example.txt'), 'Source for a fresh snapshot.\n');
    await git(['add', '.'], source);
    await git(['-c', 'user.name=Snapshot Test', '-c', 'user.email=snapshot@example.test', 'commit', '-m', 'Fixture'], source);
    const sha = (await git(['rev-parse', 'HEAD'], source)).trim();
    await mkdir(bare, { recursive: true }); await git(['init', '--bare', bare]);
    if (process.platform === 'win32') {
      env.GIT_CONFIG_VALUE_1 = 'false';
      await assert.rejects(git(['--git-dir', bare, 'fetch', '--no-tags', '--no-write-fetch-head', source, sha]));
      env.GIT_CONFIG_VALUE_1 = 'true';
    }
    await git(['--git-dir', bare, 'fetch', '--no-tags', '--no-write-fetch-head', source, sha]);
    assert.equal((await git(['--git-dir', bare, 'cat-file', '-p', `${sha}:example.txt`])).trim(), 'Source for a fresh snapshot.');
  } finally { await rm(root, { recursive: true, force: true }); }
});
