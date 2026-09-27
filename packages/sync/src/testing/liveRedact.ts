/**
 * Scrubs Google credentials out of the live suites' diagnostics before CI
 * uploads them. Maestro writes every `MAESTRO_*` variable — the live
 * access token included — into each flow's `commands.json` and into
 * `maestro.log`, and `::add-mask::` only covers the job log, never an
 * artifact's files.
 *
 * Effect-free and free of workspace imports on purpose: Node 24 runs this
 * file as-is (type stripping) for `scripts/redact-live-reports.ts`.
 */
import { existsSync, lstatSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export const REDACTED = '[REDACTED]';

/**
 * Credential shapes, whatever variable carried them: Google access tokens
 * and refresh tokens (`1//…`, also with JSON's optional `\/` escaping).
 */
const TOKEN_PATTERNS: ReadonlyArray<RegExp> = [/ya29\.[\w.-]+/g, /1(?:\/|\\\/){2}[\w-]{20,}/g];

/** Shorter values are too likely to occur by accident to replace blindly. */
const MIN_SECRET_LENGTH = 8;

const variants = (secrets: ReadonlyArray<string>): ReadonlyArray<string> =>
  [
    ...new Set(
      secrets
        .filter((secret) => secret.length >= MIN_SECRET_LENGTH)
        .flatMap((secret) => [secret, secret.replaceAll('/', String.raw`\/`)]),
    ),
  ].toSorted((a, b) => b.length - a.length);

/** `text` with every known secret and credential-shaped string replaced. */
export const redactSecrets = (
  text: string,
  secrets: ReadonlyArray<string>,
): { readonly count: number; readonly text: string } => {
  let count = 0;
  let result = text;
  for (const secret of variants(secrets)) {
    const parts = result.split(secret);
    count += parts.length - 1;
    result = parts.join(REDACTED);
  }
  for (const pattern of TOKEN_PATTERNS) {
    result = result.replace(pattern, () => {
      count++;
      return REDACTED;
    });
  }
  return { count, text: result };
};

export const containsSecret = (text: string, secrets: ReadonlyArray<string>): boolean =>
  redactSecrets(text, secrets).count > 0;

export interface RedactReport {
  /** Regular files scanned. */
  readonly files: number;
  /** Text files rewritten, with how many values each lost. */
  readonly redacted: ReadonlyArray<{ readonly count: number; readonly path: string }>;
  /**
   * Deleted instead: binaries holding a credential (rewriting them would
   * corrupt them) and symlinks (the upload would follow them unscanned).
   */
  readonly removed: ReadonlyArray<string>;
}

/**
 * Redacts every file under `paths` in place. Missing paths are skipped, so
 * a job that failed before Maestro ran still passes through.
 */
export const redactTree = (
  paths: ReadonlyArray<string>,
  secrets: ReadonlyArray<string>,
): RedactReport => {
  let files = 0;
  const redacted: Array<{ count: number; path: string }> = [];
  const removed: Array<string> = [];

  const visit = (path: string): void => {
    const stat = lstatSync(path);
    if (stat.isSymbolicLink()) {
      rmSync(path);
      removed.push(path);
    } else if (stat.isDirectory()) {
      for (const entry of readdirSync(path)) {
        visit(join(path, entry));
      }
    } else if (stat.isFile()) {
      files++;
      const buffer = readFileSync(path);
      if (buffer.includes(0)) {
        if (containsSecret(buffer.toString('latin1'), secrets)) {
          rmSync(path);
          removed.push(path);
        }
        return;
      }
      const result = redactSecrets(buffer.toString('utf8'), secrets);
      if (result.count > 0) {
        writeFileSync(path, result.text);
        redacted.push({ count: result.count, path });
      }
    }
  };

  for (const path of paths) {
    if (existsSync(path)) {
      visit(path);
    }
  }
  return { files, redacted, removed };
};
