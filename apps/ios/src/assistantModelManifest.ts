/**
 * The Assistant's model: a Qwen3.5 0.8B trained for the tuned path, as a
 * GGUF file (Q8_0) published on GitHub (`nikgraf/calendar-models`, its
 * README says how it was made and from what). The app downloads it once,
 * after asking (`assistantModelOffer.ts`), and checks it by size and
 * SHA-256 before it is loaded. A new version is a new release: the
 * version changes, and the app asks again.
 */
export interface AssistantModelManifest {
  readonly bytes: number;
  /** The file's name under the app's caches. */
  readonly file: string;
  readonly sha256: string;
  readonly url: string;
  readonly version: string;
}

/** Release v1 of `nikgraf/calendar-models`. */
export const PUBLISHED_MODEL: AssistantModelManifest = {
  bytes: 833_592_288,
  file: 'solunivo-assistant-q8_0.gguf',
  sha256: '954ca95027feb405e2f98ef26fdeb0814d2fdbf4bd2ebddbeb9e9c321ba838d3',
  url: 'https://github.com/nikgraf/calendar-models/releases/download/v1/solunivo-assistant-q8_0.gguf',
  version: 'v1',
};

const isManifest = (value: unknown): value is AssistantModelManifest => {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const record = value as Record<string, unknown>;
  return (
    typeof record['bytes'] === 'number' &&
    typeof record['file'] === 'string' &&
    typeof record['sha256'] === 'string' &&
    typeof record['url'] === 'string' &&
    typeof record['version'] === 'string'
  );
};

/**
 * The model the app fetches: `EXPO_PUBLIC_ASSISTANT_MODEL` (a JSON
 * manifest, for a file served from the Mac to a dev build or the
 * simulator) when it is set and valid, else the published one.
 */
export const assistantModelManifest = (
  override: string | undefined,
  published: AssistantModelManifest = PUBLISHED_MODEL,
): AssistantModelManifest => {
  if (override?.trim()) {
    try {
      const parsed: unknown = JSON.parse(override);
      if (isManifest(parsed)) {
        return parsed;
      }
    } catch {
      // Not JSON: the published model stands.
    }
  }
  return published;
};

/** The size as a person reads it: "834 MB". */
export const sizeLabel = (bytes: number): string =>
  bytes >= 1e9 ? `${(bytes / 1e9).toFixed(1)} GB` : `${String(Math.round(bytes / 1e6))} MB`;
