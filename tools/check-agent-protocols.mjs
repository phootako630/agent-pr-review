import { readFile } from 'node:fs/promises';
import { actionsConfigSchema } from '../dist/actions.js';
import { selectedReviewers } from '../dist/contracts.js';
import { probeCodex } from '../dist/provider.js';
import { probeNative } from '../dist/native-providers.js';

const config = actionsConfigSchema.parse(JSON.parse(await readFile(new URL('../.github/agent-review.json', import.meta.url), 'utf8')));
const signal = AbortSignal.timeout(30_000);
for (const reviewer of selectedReviewers(config.review)) {
  if (reviewer.name === 'fake') throw new Error('Hosted reviews require live provider protocols.');
  const version = reviewer.name === 'codex' ? await probeCodex(signal) : await probeNative(reviewer.name, signal);
  if (!reviewer.version || reviewer.version !== version) throw new Error(`Hosted ${reviewer.name} version pin does not match its actual protocol probe.`);
  console.log(version);
}
