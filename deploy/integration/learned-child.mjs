import { readFile } from 'node:fs/promises';
import { runLearnedLifecycle } from './learned-execute.ts';

const options = JSON.parse(await readFile(process.argv[2], 'utf8'));
await runLearnedLifecycle({ ...options, cancellation: new AbortController() });
if (process.connected) process.disconnect();
