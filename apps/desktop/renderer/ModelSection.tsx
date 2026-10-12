import { useEffect, useRef, useState } from 'react';
import type { EndpointProbe, ModelProviderKind, ModelProviderView } from './backend.ts';
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

/** What a probe was asked about: its result shows only while the fields still say this. */
interface ProbeInputs {
  readonly apiKey: string;
  readonly baseUrl: string;
  readonly kind: ModelProviderKind;
}

type Probe =
  | { readonly kind: 'idle' }
  | { readonly for: ProbeInputs; readonly kind: 'probing' }
  | {
      readonly error?: string | undefined;
      readonly for: ProbeInputs;
      readonly kind: 'done';
      readonly models: ReadonlyArray<string>;
      readonly reachable: boolean;
      readonly unauthorized?: boolean | undefined;
    };

const sameInputs = (left: ProbeInputs, right: ProbeInputs): boolean =>
  left.baseUrl === right.baseUrl && left.kind === right.kind && left.apiKey === right.apiKey;

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
  // Only the latest probe's answer is taken.
  const probeId = useRef(0);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // What the fields say now, and the latest render's copy of it for a
  // probe landing after an edit.
  const kind = view?.kind ?? 'apple';
  const now: ProbeInputs = { apiKey, baseUrl, kind };
  const fields = useRef(now);
  useEffect(() => {
    fields.current = { apiKey, baseUrl, kind };
  }, [apiKey, baseUrl, kind]);

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

  // A probe answers for the fields as they were when it was sent. Its
  // result shows only while the fields still name that endpoint, and only
  // that endpoint's own list fills an empty model field — an answer from
  // one server never describes, or picks a model on, another.
  const test = async () => {
    const asked = now;
    const mine = ++probeId.current;
    setProbe({ for: asked, kind: 'probing' });
    setError(null);
    let result: EndpointProbe;
    try {
      result = await window.calendarBridge.modelProviderTest({
        ...(asked.apiKey ? { apiKey: asked.apiKey } : {}),
        baseUrl: asked.baseUrl,
        kind: asked.kind,
      });
    } catch (error) {
      result = { error: String(error), models: [], reachable: false };
    }
    if (mine !== probeId.current) {
      return;
    }
    setProbe({ for: asked, kind: 'done', ...result });
    const [first] = result.models;
    if (result.reachable && first !== undefined && sameInputs(fields.current, asked)) {
      setModel((current) => (current === '' ? first : current));
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
  // The probe on show: the one for the fields as they are now.
  const shownProbe: Probe =
    probe.kind !== 'idle' && sameInputs(probe.for, now) ? probe : { kind: 'idle' };
  const listed = shownProbe.kind === 'done' ? shownProbe.models : [];
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
              disabled={shownProbe.kind === 'probing' || baseUrl === ''}
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
            {shownProbe.kind === 'probing' ? (
              <span className="text-xs text-ink-secondary">Checking…</span>
            ) : shownProbe.kind === 'done' ? (
              <span
                className={`text-xs ${shownProbe.reachable ? 'text-ink-secondary' : 'text-danger'}`}
                data-testid="model-test-result"
              >
                {shownProbe.reachable
                  ? shownProbe.models.length > 0
                    ? `Reachable · ${String(shownProbe.models.length)} ${shownProbe.models.length === 1 ? 'model' : 'models'}`
                    : 'Reachable'
                  : shownProbe.unauthorized
                    ? 'The server refused the API key'
                    : `Not reachable${shownProbe.error ? ` — ${shownProbe.error}` : ''}`}
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
