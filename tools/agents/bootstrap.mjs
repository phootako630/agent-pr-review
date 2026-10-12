import { copyFile, mkdir, chmod, access, readFile, writeFile } from 'node:fs/promises';
import { brotliDecompressSync } from 'node:zlib';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

// Install only the pinned optional native packages; never execute installers.
const root = dirname(fileURLToPath(import.meta.url));
const platform = process.platform, arch = process.arch;
if (!['linux', 'win32'].includes(platform) || arch !== 'x64') throw new Error('CI tool bootstrap supports Linux/Windows x64.');
const output = join(root, 'native');
await mkdir(output, { recursive: true });
for (const [scope, name] of [['@anthropic-ai', 'claude-code'], ['@xai-official', 'grok']]) {
  const binary = name === 'claude-code' ? 'claude' : 'grok';
  const candidates = [binary, `bin/${binary}`, `bin/${binary}.exe`, `${binary}.exe`, `bin/${binary}.br`, `bin/${binary}.exe.br`];
  const packageDirectory = join(root, 'node_modules', scope, `${name}-${platform}-${arch}`);
  let source;
  for (const candidate of candidates) { try { await access(join(packageDirectory, candidate)); source = join(packageDirectory, candidate); break; } catch {} }
  if (!source) throw new Error(`Pinned native ${binary} package is missing its executable.`);
  const destination = join(output, `${binary}${platform === 'win32' ? '.exe' : ''}`);
  if (source.endsWith('.br')) await writeFile(destination, brotliDecompressSync(await readFile(source)));
  else await copyFile(source, destination);
  await chmod(destination, 0o755);
}
console.log('Pinned native executables prepared.');
