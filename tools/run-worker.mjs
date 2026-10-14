import { dirname, delimiter, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
const root = dirname(dirname(fileURLToPath(import.meta.url)));
process.chdir(root);
process.env.PATH = [join(root, 'tools', 'agents', 'native'), join(root, 'tools', 'agents', 'node_modules', '.bin'), process.env.PATH].join(delimiter);
process.argv = [process.execPath, join(root, 'dist', 'cli.js'), 'worker', 'start', ...process.argv.slice(2)];
// Keep signal handling in one Node process, including Windows Ctrl+C cleanup.
await import(pathToFileURL(join(root, 'dist', 'cli.js')).href);
