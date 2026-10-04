import { spawn } from 'node:child_process';

// A supervisor, not a model transport. The parent must register this process
// group before sending start; no host/model code runs before that handshake.
const [binary, ...args] = process.argv.slice(2);
if (!binary || !args.length) throw new Error('Missing published host command');
let input = '', started = false, interrupted = false, child;
const interrupt = () => {
  interrupted = true;
  if (child) child.kill('SIGTERM');
  else { process.exitCode = 1; process.stdin.destroy(); }
};
process.on('SIGTERM', interrupt); process.on('SIGINT', interrupt);
const timeout = setTimeout(() => { process.exitCode = 1; process.stdin.destroy(); }, 10_000);
process.stdin.setEncoding('utf8');
process.stdin.on('data', chunk => {
  input += chunk;
  if (started || input.length > 32 || !'start\n'.startsWith(input)) { process.exitCode = 1; process.stdin.destroy(); return; }
  if (input !== 'start\n') return;
  started = true; clearTimeout(timeout); process.stdin.pause();
  child = spawn(binary, args, { detached: false, stdio: ['ignore', 'inherit', 'inherit'], env: process.env });
  child.once('error', () => { process.exitCode = 1; process.stdin.destroy(); });
  child.once('close', (code, signal) => { process.exitCode = interrupted || signal ? 1 : code ?? 1; process.stdin.destroy(); });
});
process.stdin.on('end', () => { clearTimeout(timeout); if (!started) process.exitCode = 1; });
process.stdin.on('error', () => { clearTimeout(timeout); process.exitCode = 1; });
