import {
  FLOW_DOWNLOADS,
  FLOW_MODELS,
  type FlowModel,
  type FlowModelStatus,
  flowPromise,
  PARAKEET_BYTES,
  PUBLISHED_MODEL,
  phrasesModelStatus,
  speechModelStatus,
} from '@calendar/ai';
import { SETTINGS_HASH } from './settingsPanes.ts';
import { useAssistantModelState } from './ai/assistantModel.ts';
import { useParakeetState } from './ai/parakeetModel.ts';
import { AssistantFlow } from './calendar/assistant/AssistantFlow.tsx';
import { Button } from './ui/Button.tsx';
import { TEXT_LINK_CLASS } from './ui/buttonStyles.ts';

const runPhrases = (kind: 'download' | 'mobile' | 'retry') => {
  void (kind === 'retry'
    ? window.calendarBridge.assistantRetry()
    : window.calendarBridge.assistantDownload());
};

const runSpeech = (kind: 'download' | 'mobile' | 'retry') => {
  void (kind === 'retry'
    ? window.calendarBridge.parakeetRetry()
    : window.calendarBridge.parakeetDownload());
};

/** One model: its name and what it does, where it stands, its progress and its one action. */
function ModelItem({
  model,
  onAction,
  status,
}: {
  readonly model: FlowModel;
  readonly onAction: (kind: 'download' | 'mobile' | 'retry') => void;
  readonly status: FlowModelStatus;
}) {
  const info = FLOW_MODELS[model];
  return (
    <li className="flex items-center gap-3 py-2.5" data-testid={`assistant-model-${model}`}>
      <div className="min-w-0 flex-1">
        <p className="text-sm font-medium">
          {info.name}
          {info.optional ? (
            <span className="ml-2 rounded-full bg-fill px-2 py-0.5 text-[11px] font-medium text-ink-secondary">
              Optional
            </span>
          ) : null}
        </p>
        <p className="text-xs text-ink-secondary">{info.does}</p>
        <p className="mt-1 text-xs" data-testid={`assistant-model-${model}-status`}>
          {status.line}
        </p>
        {status.progress === undefined ? null : (
          <div
            aria-label={`${String(status.progress)} percent downloaded`}
            aria-valuemax={100}
            aria-valuemin={0}
            aria-valuenow={status.progress}
            className="mt-1.5 h-1 w-full overflow-hidden rounded-full bg-hairline-strong"
            role="progressbar"
          >
            <div
              className="h-full rounded-full bg-primary"
              style={{ width: `${String(status.progress)}%` }}
            />
          </div>
        )}
      </div>
      {status.action === undefined ? null : (
        <Button
          data-testid={`assistant-model-${model}-action`}
          onClick={() => {
            if (status.action !== undefined) {
              onAction(status.action.kind);
            }
          }}
          size="sm"
        >
          {status.action.label}
        </Button>
      )}
    </li>
  );
}

/**
 * Settings › AI Model, first section: the Assistant. That it uses only
 * models on this Mac, how a phrase becomes an event (`AssistantFlow`), and
 * the two models with where each stands and its one action. The speech
 * model's switch and Delete stay in Dictation.
 */
export function AssistantModelSection() {
  const state = useAssistantModelState();
  const speechState = useParakeetState();
  const phrases =
    state === undefined
      ? undefined
      : phrasesModelStatus(state, {
          device: 'Mac',
          network: undefined,
          size: PUBLISHED_MODEL.bytes,
        });
  const speech =
    speechState === undefined || speechState.files.kind === 'unsupported'
      ? undefined
      : speechModelStatus(speechState, { device: 'Mac', network: undefined });
  return (
    <section
      className="rounded-popover bg-surface-subtle p-4"
      data-testid="assistant-model-section"
    >
      <h2 className="font-medium">Assistant</h2>
      <p className="mt-1 text-sm text-ink-secondary" data-testid="assistant-promise">
        {flowPromise('Mac')}
      </p>
      <h3 className="mt-4 mb-2 text-xs font-medium text-ink-secondary">How it works</h3>
      <AssistantFlow sizes={{ phrases: PUBLISHED_MODEL.bytes, speech: PARAKEET_BYTES }} />
      <h3 className="mt-4 text-xs font-medium text-ink-secondary">Models</h3>
      <ul className="divide-y divide-hairline">
        {phrases === undefined ? null : (
          <ModelItem model="phrases" onAction={runPhrases} status={phrases} />
        )}
        {speech === undefined ? null : (
          <ModelItem model="speech" onAction={runSpeech} status={speech} />
        )}
      </ul>
      <p className="mt-2 text-xs text-ink-secondary">
        {FLOW_DOWNLOADS}
        {speech === undefined ? null : (
          <>
            {' '}
            The speech model’s switch and Delete are in{' '}
            <button
              className={TEXT_LINK_CLASS}
              data-testid="assistant-open-dictation"
              onClick={() => window.location.replace(`${SETTINGS_HASH}/dictation`)}
              type="button"
            >
              Dictation
            </button>
            .
          </>
        )}
      </p>
    </section>
  );
}
