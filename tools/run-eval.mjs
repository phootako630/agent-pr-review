// Use the same pinned CLIs as the worker, without replacing global installations.
import { dirname, delimiter, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
process.env.PATH = [resolve(root, 'tools/agents/native'), resolve(root, 'tools/agents/node_modules/.bin'), process.env.PATH ?? ''].join(delimiter);
process.argv.splice(1, 1, resolve(root, 'dist/cli.js'), 'eval');
await import('../dist/cli.js');
