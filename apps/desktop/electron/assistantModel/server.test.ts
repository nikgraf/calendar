import { spawn } from 'node:child_process';
import { chmodSync, existsSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vite-plus/test';
import { contentOf, createLlamaServer, reapLeftovers, socketPathFor } from './server.ts';

describe('contentOf', () => {
  it('reads the answer of a chat completion, and refuses what is not one', () => {
    const answer = '{"kind":"event","title":"Lunch","date":"2026-11-14","startTime":"13:00"}';
    expect(
      contentOf({
        body: JSON.stringify({ choices: [{ message: { content: answer, role: 'assistant' } }] }),
        status: 200,
      }),
    ).toBe(answer);
    expect(() => contentOf({ body: '{"error":"no key"}', status: 401 })).toThrow('answered 401');
    expect(() => contentOf({ body: JSON.stringify({ choices: [] }), status: 200 })).toThrow(
      'gave no answer',
    );
  });
});

describe('createLlamaServer', () => {
  it('answers a binary that cannot start with an error, and the app goes on', async () => {
    const folder = mkdtempSync(join(tmpdir(), 'llama-server-'));
    const binary = join(folder, 'llama-server');
    writeFileSync(binary, 'not a program');
    chmodSync(binary, 0o644);
    const pidFile = join(folder, 'llama-server.pid');
    const server = createLlamaServer({ binary, pidFile, socketPath: join(folder, 's.sock') });
    server.use(join(folder, 'model.gguf'));
    const started = Date.now();
    await expect(server.ask('Lunch at 1')).rejects.toThrow('could not start');
    expect(Date.now() - started).toBeLessThan(10_000);
    expect(existsSync(pidFile)).toBe(false);
  });
});

describe('reapLeftovers', () => {
  it('stops the server an earlier launch left, only where the pid still runs that binary', async () => {
    const folder = mkdtempSync(join(tmpdir(), 'llama-reap-'));
    const pidFile = join(folder, 'llama-server.pid');
    const left = spawn('/bin/sleep', ['30'], { stdio: 'ignore' });
    const exited = new Promise((resolve) => left.on('exit', resolve));
    writeFileSync(pidFile, String(left.pid));
    // Another program under that pid now: it stays.
    reapLeftovers({ binary: '/nonexistent/llama-server', pidFile, socketFolder: folder });
    expect(left.exitCode).toBeNull();
    expect(left.killed).toBe(false);
    writeFileSync(pidFile, String(left.pid));
    reapLeftovers({ binary: '/bin/sleep', pidFile, socketFolder: folder });
    await exited;
    expect(existsSync(pidFile)).toBe(false);
  });

  it('removes the socket of a launch that is gone, and keeps a live one’s', () => {
    const folder = mkdtempSync(join(tmpdir(), 'llama-sockets-'));
    const gone = socketPathFor(folder, 999_999_999);
    const live = socketPathFor(folder, process.pid);
    writeFileSync(gone, '');
    writeFileSync(live, '');
    reapLeftovers({
      binary: '/nonexistent',
      pidFile: join(folder, 'none.pid'),
      socketFolder: folder,
    });
    expect(existsSync(gone)).toBe(false);
    expect(existsSync(live)).toBe(true);
  });
});
