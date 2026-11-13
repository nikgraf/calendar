import { createHash } from 'node:crypto';
import {
  createReadStream,
  createWriteStream,
  existsSync,
  mkdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { readdir, rename, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { ReadableStream as WebReadableStream } from 'node:stream/web';
import { type AssistantModelManifest, storedFileName } from '@calendar/ai';
import type { Fetch, MacAnswer, ModelFiles } from './store.ts';

/**
 * The store's files under `<userData>/assistant-model/`: the model, its
 * partial download (`.part`), a note of the checked file
 * (`.verified.json`), and the person's answer (`answer.json`, per version).
 */

const readJson = (path: string): unknown => {
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as unknown;
  } catch {
    return undefined;
  }
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null;

const sizeOf = (path: string): number | undefined => {
  try {
    return statSync(path).size;
  } catch {
    return undefined;
  }
};

export const modelFolder = (userDataDir: string): string => join(userDataDir, 'assistant-model');

export const nodeModelFiles = (folder: string, manifest: AssistantModelManifest): ModelFiles => {
  const name = storedFileName(manifest);
  const destination = join(folder, name);
  const part = `${destination}.part`;
  const verifiedNote = `${destination}.verified.json`;
  const answerNote = join(folder, 'answer.json');
  const write = (path: string, value: unknown) => {
    mkdirSync(folder, { recursive: true });
    writeFileSync(path, JSON.stringify(value));
  };
  // Only this version's files stay: another version's (or one from before names held the version) go.
  const keep = new Set([name, `${name}.part`, `${name}.verified.json`]);
  return {
    destination,
    exists: () => existsSync(destination),
    finish: () => rename(part, destination),
    partSize: () => sizeOf(part) ?? 0,
    readAnswer: () => {
      const note = readJson(answerNote);
      return isRecord(note) &&
        (note['answer'] === 'agreed' || note['answer'] === 'declined') &&
        typeof note['version'] === 'string'
        ? { answer: note['answer'] as MacAnswer, version: note['version'] }
        : undefined;
    },
    readVerified: () => {
      const note = readJson(verifiedNote);
      return isRecord(note) &&
        typeof note['sha256'] === 'string' &&
        typeof note['version'] === 'string'
        ? { sha256: note['sha256'], version: note['version'] }
        : undefined;
    },
    remove: async () => {
      await rm(destination, { force: true });
      await rm(part, { force: true });
    },
    removeOthers: async () => {
      const names = await readdir(folder).catch(() => [] as Array<string>);
      await Promise.all(
        names
          .filter((name) => name !== 'answer.json' && !keep.has(name))
          .map((name) => rm(join(folder, name), { force: true, recursive: true })),
      );
    },
    sha256: async () => {
      const hash = createHash('sha256');
      await pipeline(createReadStream(destination), hash);
      return hash.digest('hex');
    },
    size: () => sizeOf(destination),
    writeAnswer: (answer) => write(answerNote, answer),
    writeVerified: (verified) => write(verifiedNote, verified),
  };
};

/** Progress reaches the windows at most this often. */
const PROGRESS_EVERY_MS = 250;

/**
 * The download into the partial file: GitHub's release link redirects to
 * its asset host, which honours `Range`, so a launch goes on from the
 * bytes the last one fetched. A server that answers the whole file (200)
 * starts the file over, and so does one that finds nothing past the bytes
 * there are (416: a part that is whole, or longer than the file).
 */
export const nodeFetch =
  (folder: string, manifest: AssistantModelManifest): Fetch =>
  async ({ from, onProgress, signal, url }) => {
    mkdirSync(folder, { recursive: true });
    const part = join(folder, `${storedFileName(manifest)}.part`);
    const ask = (start: number) =>
      fetch(url, { headers: start > 0 ? { Range: `bytes=${String(start)}-` } : {}, signal });
    let response = await ask(from);
    if (response.status === 416 && from > 0) {
      response = await ask(0);
    }
    if (!response.ok || response.body === null) {
      throw new Error(`The server answered ${String(response.status)}.`);
    }
    const resumed = response.status === 206;
    let received = resumed ? from : 0;
    const length = Number(response.headers.get('content-length') ?? 0);
    const total = length > 0 ? received + length : manifest.bytes;
    let reported = 0;
    const counted = Readable.fromWeb(response.body as WebReadableStream<Uint8Array>);
    counted.on('data', (chunk: Buffer) => {
      received += chunk.length;
      const now = Date.now();
      if (now - reported >= PROGRESS_EVERY_MS) {
        reported = now;
        onProgress(received, total);
      }
    });
    await pipeline(counted, createWriteStream(part, { flags: resumed ? 'a' : 'w' }), { signal });
    onProgress(received, total);
  };
