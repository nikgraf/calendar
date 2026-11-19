import { spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

export const runBombadil = (
  args: ReadonlyArray<string>,
  output: string,
  signal: AbortSignal,
): Promise<void> =>
  new Promise((resolve, reject) => {
    signal.throwIfAborted();
    const child = spawn('pnpm', ['exec', 'bombadil', 'browser', 'test-external', ...args], {
      cwd: join(import.meta.dirname, '../..'),
      // pnpm and the Node shim spawn the Rust binary. Cancellation must
      // stop their entire process group, including replay runs.
      detached: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const chunks: Array<string> = [];
    child.stdout.on('data', (chunk: Buffer) => chunks.push(chunk.toString()));
    child.stderr.on('data', (chunk: Buffer) => chunks.push(chunk.toString()));
    const stop = () => {
      if (child.pid && child.exitCode === null) {
        try {
          process.kill(-child.pid, 'SIGKILL');
        } catch {
          // The process group may already have exited.
        }
      }
    };
    const timer = setTimeout(stop, 150_000);
    signal.addEventListener('abort', stop, { once: true });
    const cleanup = () => {
      clearTimeout(timer);
      signal.removeEventListener('abort', stop);
    };
    child.once('error', (error) => {
      cleanup();
      reject(error);
    });
    child.once('close', (code, endedBy) => {
      cleanup();
      const log = chunks.join('');
      writeFileSync(join(output, 'bombadil.log'), log);
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(`Bombadil exited ${String(code ?? endedBy)}\n${log.slice(-6000)}`));
      }
    });
  });
