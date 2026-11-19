import { type AssistantModelState, noticeCopy, PUBLISHED_MODEL } from '@calendar/ai';
import { Button } from '../../ui/Button.tsx';

/** The notice's one action: download (the person agrees), or try a failed download again. */
const runAction = (kind: 'download' | 'mobile' | 'retry') => {
  void (kind === 'retry'
    ? window.calendarBridge.assistantRetry()
    : window.calendarBridge.assistantDownload());
};

/**
 * What stands in the Assistant's place while its model is not on this Mac
 * yet: the download's progress and that the Assistant will be available
 * soon, or what the person can do — download it (the size said) or try
 * again. The form works meanwhile. The same words as the iPhone's
 * (`noticeCopy` in @calendar/ai).
 */
export function AssistantModelNotice({ state }: { readonly state: AssistantModelState }) {
  const copy = noticeCopy(state, {
    device: 'Mac',
    network: undefined,
    size: PUBLISHED_MODEL.bytes,
  });
  return (
    <div
      className="flex flex-col items-start gap-2 rounded-control bg-fill p-3"
      data-testid="assistant-model-notice"
    >
      {copy.lines.map((line, index) => (
        <p
          className={index === 0 ? 'text-sm text-ink' : 'text-sm text-ink-secondary'}
          data-testid={index === 0 ? 'assistant-model-notice-text' : undefined}
          key={line}
        >
          {line}
        </p>
      ))}
      {copy.progress === undefined ? null : (
        <div
          aria-label={`${String(copy.progress)} percent downloaded`}
          aria-valuemax={100}
          aria-valuemin={0}
          aria-valuenow={copy.progress}
          className="h-1 w-full overflow-hidden rounded-full bg-hairline-strong"
          role="progressbar"
        >
          <div
            className="h-full rounded-full bg-primary"
            style={{ width: `${String(copy.progress)}%` }}
          />
        </div>
      )}
      {copy.action === undefined ? null : (
        <Button
          data-testid={`assistant-model-${copy.action.kind}`}
          onClick={() => {
            if (copy.action) {
              runAction(copy.action.kind);
            }
          }}
          size="sm"
        >
          {copy.action.label}
        </Button>
      )}
    </div>
  );
}
