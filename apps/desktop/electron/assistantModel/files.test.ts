import { createHash } from 'node:crypto';
import { mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AssistantModelManifest } from '@calendar/ai';
import { afterEach, describe, expect, it } from 'vite-plus/test';
import { nodeFetch, nodeModelFiles } from './files.ts';

const BODY = Buffer.from(Array.from({ length: 5000 }, (_, index) => index % 251));

const manifestFor = (url: string): AssistantModelManifest => ({
  bytes: BODY.length,
  file: 'model.gguf',
  sha256: createHash('sha256').update(BODY).digest('hex'),
  url,
  version: 'v1',
});

let server: Server | undefined;

/** Serves BODY, honouring `Range` unless told not to; records each request's range. */
const serve = async (honourRange: boolean) => {
  const ranges: Array<string | undefined> = [];
  server = createServer((request, response) => {
    const range = request.headers.range;
    ranges.push(range);
    const from = honourRange && range ? Number(/bytes=(\d+)-/u.exec(range)?.[1] ?? 0) : 0;
    response.writeHead(from > 0 ? 206 : 200, { 'Content-Length': BODY.length - from });
    response.end(BODY.subarray(from));
  });
  await new Promise<void>((resolve) => server?.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return { ranges, url: `http://127.0.0.1:${String(port)}/model.gguf` };
};

afterEach(() => {
  server?.close();
  server = undefined;
});

const run = (folder: string, manifest: AssistantModelManifest, from: number) => {
  const progress: Array<number> = [];
  return nodeFetch(
    folder,
    manifest,
  )({
    from,
    onProgress: (received) => progress.push(received),
    signal: new AbortController().signal,
    url: manifest.url,
  }).then(() => progress);
};

describe('nodeFetch and nodeModelFiles', () => {
  it('downloads the whole file, moves it into place and checks it', async () => {
    const { url } = await serve(true);
    const folder = mkdtempSync(join(tmpdir(), 'assistant-files-'));
    const manifest = manifestFor(url);
    const files = nodeModelFiles(folder, manifest);
    const progress = await run(folder, manifest, files.partSize());
    expect(progress.at(-1)).toBe(BODY.length);
    await files.finish();
    expect(files.size()).toBe(BODY.length);
    expect(await files.sha256()).toBe(manifest.sha256);
  });

  it('goes on from a partial file with Range, and starts over when the server sends it all', async () => {
    const folder = mkdtempSync(join(tmpdir(), 'assistant-files-'));
    const resuming = await serve(true);
    const manifest = manifestFor(resuming.url);
    writeFileSync(join(folder, 'v1-model.gguf.part'), BODY.subarray(0, 1200));
    await run(folder, manifest, 1200);
    expect(resuming.ranges).toEqual(['bytes=1200-']);
    expect(readFileSync(join(folder, 'v1-model.gguf.part')).equals(BODY)).toBe(true);
    server?.close();

    const whole = await serve(false);
    const other = manifestFor(whole.url);
    writeFileSync(join(folder, 'v1-model.gguf.part'), BODY.subarray(0, 1200));
    await run(folder, other, 1200);
    expect(readFileSync(join(folder, 'v1-model.gguf.part')).equals(BODY)).toBe(true);
  });

  it('keeps the answer and this version’s files, and removes another version’s of the same name', async () => {
    const folder = mkdtempSync(join(tmpdir(), 'assistant-files-'));
    const files = nodeModelFiles(folder, manifestFor('http://127.0.0.1:1/model.gguf'));
    expect(files.destination).toBe(join(folder, 'v1-model.gguf'));
    files.writeAnswer({ answer: 'agreed', version: 'v1' });
    files.writeVerified({ sha256: 'x', version: 'v1' });
    writeFileSync(join(folder, 'v1-model.gguf'), 'm');
    // The last release's file, same name: it must never pass for this one.
    writeFileSync(join(folder, 'v0-model.gguf'), 'o');
    writeFileSync(join(folder, 'v0-model.gguf.part'), 'o');
    writeFileSync(join(folder, 'model.gguf'), 'o');
    await files.removeOthers();
    expect(readdirSync(folder).toSorted()).toEqual([
      'answer.json',
      'v1-model.gguf',
      'v1-model.gguf.verified.json',
    ]);
    expect(files.readAnswer()).toEqual({ answer: 'agreed', version: 'v1' });
  });

  it('starts over when the server finds nothing past the part (416)', async () => {
    const folder = mkdtempSync(join(tmpdir(), 'assistant-files-'));
    const ranges: Array<string | undefined> = [];
    server = createServer((request, response) => {
      ranges.push(request.headers.range);
      if (request.headers.range) {
        response.writeHead(416);
        response.end();
        return;
      }
      response.writeHead(200, { 'Content-Length': BODY.length });
      response.end(BODY);
    });
    await new Promise<void>((resolve) => server?.listen(0, '127.0.0.1', resolve));
    const { port } = server.address() as AddressInfo;
    const manifest = manifestFor(`http://127.0.0.1:${String(port)}/model.gguf`);
    writeFileSync(join(folder, 'v1-model.gguf.part'), Buffer.concat([BODY, BODY.subarray(0, 10)]));
    await run(folder, manifest, BODY.length + 10);
    expect(ranges).toEqual([`bytes=${String(BODY.length + 10)}-`, undefined]);
    expect(readFileSync(join(folder, 'v1-model.gguf.part')).equals(BODY)).toBe(true);
  });
});
