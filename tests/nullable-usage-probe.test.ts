import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { promisify } from 'node:util';
import { test } from 'node:test';

const execute = promisify(execFile);
const script = resolve('docs/measurements/nebius-nullable-usage-probe.mjs');

test('standalone usage diagnostic reserves private output before any request and preserves foreign files', async () => {
  const directory = await mkdtemp(resolve(tmpdir(), 'threadkeeper-usage-probe-'));
  const preload = resolve(directory, 'mock-fetch.mjs');
  const calls = resolve(directory, 'calls');
  const output = resolve(directory, 'evidence.json');
  await writeFile(preload, `
    import assert from 'node:assert/strict';
    import { appendFile, readFile, rename, stat, writeFile } from 'node:fs/promises';
    globalThis.fetch = async (url, init) => {
      await appendFile(process.env.PROBE_TEST_CALLS, 'fetch\\n');
      assert.equal(url, 'https://api.tokenfactory.nebius.com/v1/chat/completions');
      assert.equal((await stat(process.argv[2])).mode & 0o777, 0o600);
      assert.equal(await readFile(process.argv[2], 'utf8'), '');
      const body = JSON.parse(init.body);
      assert.equal(body.model, 'nvidia/Nemotron-3_5-Lightning');
      assert.equal(body.reasoning_effort, 'none');
      assert.equal(body.max_tokens, 32);
      if (process.env.PROBE_TEST_MODE === 'foreign') {
        await rename(process.argv[2], process.argv[2] + '.reserved');
        await writeFile(process.argv[2], 'foreign-file', { flag: 'wx' });
      }
      if (process.env.PROBE_TEST_MODE !== 'success') throw new Error('synthetic-secret provider failure');
      return new Response(JSON.stringify({model: body.model, choices: [{message:{content:'private response'}}],
        usage:{prompt_tokens:21,completion_tokens:3,total_tokens:24,completion_tokens_details:{reasoning_tokens:0,audio_tokens:null},prompt_tokens_details:null,private_text:'synthetic-secret'}}));
    };
  `);
  const run = async (args: string[], mode = 'success') => {
    try {
      const result = await execute(process.execPath, ['--import', preload, script, ...args], {
        env: { ...process.env, NODE_OPTIONS: '', NEBIUS_API_KEY: 'synthetic-secret', PROBE_TEST_CALLS: calls, PROBE_TEST_MODE: mode }, timeout: 10_000,
      });
      return { ...result, code: 0 };
    } catch (error: any) { return { stdout: error.stdout as string, stderr: error.stderr as string, code: error.code }; }
  };
  try {
    assert.equal((await run([])).code, 1);
    assert.equal((await run([resolve(directory, 'absent-parent/evidence.json')])).code, 1);
    await writeFile(output, 'existing-file');
    assert.equal((await run([output])).code, 1);
    assert.equal(await readFile(output, 'utf8'), 'existing-file');
    await assert.rejects(stat(calls), { code: 'ENOENT' });
    await rm(output);

    const success = await run([output]);
    assert.equal(success.code, 0, success.stderr);
    const evidence = JSON.parse(await readFile(output, 'utf8'));
    assert.equal(evidence.usage.total_tokens, 24);
    assert.equal(evidence.usage.completion_tokens_details.audio_tokens, null);
    assert.equal(evidence.usage.prompt_tokens_details, null);
    assert.equal((await stat(output)).mode & 0o777, 0o600);
    assert(!JSON.stringify(evidence).includes('synthetic-secret'));
    assert(!JSON.stringify(evidence).includes('private response'));
    await rm(output);

    const failed = await run([output], 'failure');
    assert.equal(failed.code, 1);
    assert(!failed.stderr.includes('synthetic-secret'));
    await assert.rejects(stat(output), { code: 'ENOENT' });

    const foreign = await run([output], 'foreign');
    assert.equal(foreign.code, 1);
    assert.equal(await readFile(output, 'utf8'), 'foreign-file');
    assert.equal((await readFile(calls, 'utf8')).trim().split('\n').length, 3);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
