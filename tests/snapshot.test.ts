import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { configSchema } from '../src/contracts.js';
import { run } from '../src/process.js';
import { gitEnvironment, readGitSnapshot } from '../src/snapshot.js';

test('real Git snapshots retain captured SHAs and handle renames, deletions, binary and special files', async () => {
  const root = await mkdtemp(join(tmpdir(), 'pr-review-git-'));
  const signal = AbortSignal.timeout(20_000);
  const git = (args: string[], input?: string) => run('git', ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', ...args], { cwd: root, env: gitEnvironment(), signal, input });
  try {
    await git(['init', '-b', 'main']);
    await writeFile(join(root, 'old name.ts'), 'const a = 1;\nconst b = 2;\nconst c = 3;\nconst d = 4;\n');
    await writeFile(join(root, 'deleted.ts'), 'export const deleted = true;\n');
    await writeFile(join(root, 'context.ts'), 'export const context = 1;\n');
    await git(['add', '.']); await git(['commit', '-m', 'base']);
    const base = (await git(['rev-parse', 'HEAD'])).trim();
    await git(['mv', 'old name.ts', 'new name.ts']);
    await writeFile(join(root, 'new name.ts'), 'const a = 9;\nconst b = 2;\nconst c = 3;\nconst d = 4;\n');
    await git(['rm', 'deleted.ts']);
    await writeFile(join(root, 'binary.bin'), Buffer.from([0, 1, 2]));
    await writeFile(join(root, 'huge.ts'), 'x'.repeat(2000));
    await writeFile(join(root, 'a[1].ts'), 'export const literal = true;\n');
    await writeFile(join(root, 'a1.ts'), 'export const other = true;\n');
    await git(['add', '.']);
    const linkOid = (await git(['hash-object', '-w', '--stdin'], '../secret')).trim();
    await git(['update-index', '--add', '--cacheinfo', `120000,${linkOid},link.ts`]);
    await git(['update-index', '--add', '--cacheinfo', `160000,${base},submodule`]);
    await git(['commit', '-m', 'head']);
    const head = (await git(['rev-parse', 'HEAD'])).trim();
    // Working tree drift must not affect the review packet.
    await writeFile(join(root, 'new name.ts'), 'uncommitted and wrong\n');
    const snapshot = await readGitSnapshot(join(root, '.git'), base, head, configSchema.parse({ maxFileBytes: 1024, contextFiles: ['context.ts', 'missing.ts'] }), signal);
    assert.equal(snapshot.mergeBaseSha, base);
    assert.equal(snapshot.totalChangedFiles, 8);
    const literal = snapshot.files.find(f => f.path === 'a[1].ts');
    assert.match(literal?.patch ?? '', /literal = true/);
    assert.ok(!literal?.patch.includes('other = true'), 'literal filename must not select another path');
    const renamed = snapshot.files.find(f => f.path === 'new name.ts');
    assert.equal(renamed?.previousPath, 'old name.ts');
    assert.match(renamed?.after ?? '', /const a = 9/);
    const deleted = snapshot.files.find(f => f.path === 'deleted.ts');
    assert.equal(deleted?.after, null);
    assert.match(deleted?.before ?? '', /deleted = true/);
    assert.equal(snapshot.files.find(f => f.path === 'context.ts')?.kind, 'context');
    for (const path of ['binary.bin', 'huge.ts', 'link.ts', 'submodule', 'missing.ts']) assert.ok(snapshot.exclusions.some(e => e.path === path), path);
    assert.equal(await readFile(join(root, 'new name.ts'), 'utf8'), 'uncommitted and wrong\n');
  } finally { await rm(root, { recursive: true, force: true }); }
});
