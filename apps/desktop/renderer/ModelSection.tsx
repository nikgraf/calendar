import { useEffect, useState } from 'react';
import type { ModelProviderKind, ModelProviderView } from './backend.ts';
import { Button } from './ui/Button.tsx';
import { FIELD_CLASS as field, LABEL_CLASS } from './ui/fieldStyles.ts';
import { SegmentedControl } from './ui/SegmentedControl.tsx';

const KIND_OPTIONS: ReadonlyArray<{ readonly label: string; readonly value: ModelProviderKind }> = [
  { label: 'Apple Intelligence', value: 'apple' },
  { label: 'Ollama', value: 'ollama' },
  { label: 'Custom endpoint', value: 'openai' },
];

/** A host on this Mac: text sent there stays here. */
export const isLoopbackUrl = (value: string): boolean => {
  try {
    const host = new URL(value).hostname.replaceAll(/^\[|\]$/g, '');
    return (
      host === 'localhost' || host === '127.0.0.1' || host === '::1' || host.endsWith('.localhost')
    );
  } catch {
    return false;
  }
};

type Probe =
  | { readonly kind: 'idle' }
  | { readonly kind: 'probing' }
  | {
      readonly error?: string | undefined;
      readonly kind: 'done';
      readonly models: ReadonlyArray<string>;
      readonly reachable: boolean;
      readonly unauthorized?: boolean | undefined;
    };

/**
 * Which model answers the AI features: Apple's on-device one (nothing to
 * set up), Ollama on this Mac, or any OpenAI-compatible endpoint. The
 * kind applies at once; the endpoint fields are saved together, after a
 * test if wanted. A host that is not this Mac gets a notice: what is
 * typed into the AI fields leaves the device then.
 */
export function ModelSection() {
  const [view, setView] = useState<ModelProviderView | null>(null);
  const [baseUrl, setBaseUrl] = useState('');
  const [model, setModel] = useState('');
  const [apiKey, setApiKey] = useState('');
  const [probe, setProbe] = useState<Probe>({ kind: 'idle' });
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let mounted = true;
    const take = (next: ModelProviderView) => {
      if (!mounted) {
        return;
      }
      setView(next);
      setBaseUrl(next.baseUrl);
      setModel(next.model);
      setApiKey('');
      setProbe({ kind: 'idle' });
    };
    void window.calendarBridge.modelProviderGet().then(take);
    const unsubscribe = window.calendarBridge.onModelProviderChanged(take);
    return () => {
      mounted = false;
      unsubscribe();
    };
  }, []);

  if (!view) {
    return null;
  }

  const chooseKind = (kind: ModelProviderKind) => {
    setError(null);
    void window.calendarBridge.modelProviderSet({ kind }).catch((error: unknown) => {
      setError(String(error));
    });
  };

  const test = async () => {
    setProbe({ kind: 'probing' });
    setError(null);
    try {
      const result = await window.calendarBridge.modelProviderTest({
        ...(apiKey ? { apiKey } : {}),
        baseUrl,
        kind: view.kind,
      });
      setProbe({ kind: 'done', ...result });
      // The server's own list: the first entry stands in for an empty model field.
      if (result.reachable && model === '' && result.models[0] !== undefined) {
        setModel(result.models[0]);
      }
    } catch (error) {
      setProbe({ error: String(error), kind: 'done', models: [], reachable: false });
    }
  };

  const save = async () => {
    setError(null);
    setSaved(false);
    try {
      await window.calendarBridge.modelProviderSet({
        ...(apiKey ? { apiKey } : {}),
        baseUrl,
        model,
      });
      setSaved(true);
    } catch (error) {
      setError(String(error));
    }
  };

  const served = view.kind !== 'apple';
  const listed = probe.kind === 'done' ? probe.models : [];
  const remote = served && baseUrl !== '' && !isLoopbackUrl(baseUrl);
  const dirty = baseUrl !== view.baseUrl || model !== view.model || apiKey !== '';

  return (
    <section className="rounded-popover bg-surface-subtle p-4" data-testid="model-section">
      <h2 className="font-medium">AI model</h2>
      <p className="mt-1 text-sm text-ink-secondary">
        What reads your phrases, pastes and changes. Apple Intelligence runs on this Mac with
        nothing to set up; Ollama or another server on this Mac can run a larger model, such as
        Gemma 4.
      </p>
      <SegmentedControl
        className="mt-3 w-full"
        grow
        label="AI model"
        onChange={chooseKind}
        options={KIND_OPTIONS.map((option) => ({
          label: option.label,
          testId: `model-kind-${option.value}`,
          value: option.value,
        }))}
        size="sm"
        value={view.kind}
      />
      {served ? (
        <div className="mt-3 flex flex-col gap-3">
          <label className={LABEL_CLASS}>
            {view.kind === 'ollama' ? 'Ollama URL' : 'Endpoint URL (up to /v1)'}
            <input
              className={`${field} mt-1`}
              data-testid="model-url"
              onChange={(changeEvent) => setBaseUrl(changeEvent.target.value)}
              placeholder={
                view.kind === 'ollama' ? 'http://localhost:11434' : 'http://localhost:1234/v1'
              }
              spellCheck={false}
              type="url"
              value={baseUrl}
            />
          </label>
          <label className={LABEL_CLASS}>
            Model
            {listed.length > 0 ? (
              <select
                className={`${field} mt-1`}
                data-testid="model-name"
                onChange={(changeEvent) => setModel(changeEvent.target.value)}
                value={listed.includes(model) ? model : ''}
              >
                <option value="">Pick one the server lists…</option>
                {listed.map((name) => (
                  <option key={name} value={name}>
                    {name}
                  </option>
                ))}
              </select>
            ) : (
              <input
                className={`${field} mt-1`}
                data-testid="model-name"
                onChange={(changeEvent) => setModel(changeEvent.target.value)}
                placeholder={view.kind === 'ollama' ? 'gemma3' : 'the model id the server uses'}
                spellCheck={false}
                type="text"
                value={model}
              />
            )}
          </label>
          {view.kind === 'openai' ? (
            <label className={LABEL_CLASS}>
              API key {view.hasApiKey ? '(one is set)' : '(optional)'}
              <input
                autoComplete="off"
                className={`${field} mt-1`}
                data-testid="model-key"
                onChange={(changeEvent) => setApiKey(changeEvent.target.value)}
                placeholder={
                  view.hasApiKey
                    ? 'Leave empty to keep the current key'
                    : 'Only if the server asks for one'
                }
                type="password"
                value={apiKey}
              />
            </label>
          ) : null}
          {remote ? (
            <p
              className="rounded-control bg-fill p-2 text-xs text-ink"
              data-testid="model-remote-notice"
            >
              This server is not on this Mac: what you type into the AI fields, and the text of what
              you paste, is sent to it.
            </p>
          ) : null}
          <div className="flex items-center gap-2">
            <Button
              data-testid="model-test"
              disabled={probe.kind === 'probing' || baseUrl === ''}
              onClick={() => void test()}
              size="sm"
            >
              Test
            </Button>
            <Button
              data-testid="model-save"
              disabled={!dirty || baseUrl === ''}
              onClick={() => void save()}
              size="sm"
              variant="primary"
            >
              Save
            </Button>
            {probe.kind === 'probing' ? (
              <span className="text-xs text-ink-secondary">Checking…</span>
            ) : probe.kind === 'done' ? (
              <span
                className={`text-xs ${probe.reachable ? 'text-ink-secondary' : 'text-danger'}`}
                data-testid="model-test-result"
              >
                {probe.reachable
                  ? probe.models.length > 0
                    ? `Reachable · ${String(probe.models.length)} ${probe.models.length === 1 ? 'model' : 'models'}`
                    : 'Reachable'
                  : probe.unauthorized
                    ? 'The server refused the API key'
                    : `Not reachable${probe.error ? ` — ${probe.error}` : ''}`}
              </span>
            ) : saved && !dirty ? (
              <span className="text-xs text-ink-secondary" data-testid="model-saved">
                Saved
              </span>
            ) : null}
          </div>
        </div>
      ) : (
        <p className="mt-3 text-xs text-ink-secondary">
          Needs macOS 26 with Apple Intelligence switched on. Nothing leaves this Mac.
        </p>
      )}
      {error ? (
        <p className="mt-2 text-xs text-danger" data-testid="model-error">
          {error}
        </p>
      ) : null}
    </section>
  );
}
