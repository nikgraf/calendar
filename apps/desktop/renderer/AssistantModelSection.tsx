import { PUBLISHED_MODEL, sizeLabel } from '@calendar/ai';
import { useAssistantModelState } from './ai/assistantModel.ts';
import { AssistantModelNotice } from './calendar/assistant/AssistantModelNotice.tsx';

/**
 * Settings › AI Model, first section: the Assistant's own model, which
 * reads what you say to the editor on this Mac (and the iPhone). Where it
 * stands, with the same action as the Assistant's notice; once it is
 * here, that it is and how much room it takes.
 */
export function AssistantModelSection() {
  const state = useAssistantModelState();
  return (
    <section
      className="rounded-popover bg-surface-subtle p-4"
      data-testid="assistant-model-section"
    >
      <p className="text-sm font-medium">Assistant</p>
      <p className="mt-1 text-sm text-ink-secondary">
        The Assistant reads what you say to the editor with a model of Solunivo’s own that runs on
        this Mac. Nothing you say leaves it.
      </p>
      <div className="mt-3">
        {state === undefined ? null : state.kind === 'ready' ? (
          <p className="text-sm" data-testid="assistant-model-ready">
            On this Mac ({sizeLabel(PUBLISHED_MODEL.bytes)}).
          </p>
        ) : (
          <AssistantModelNotice state={state} />
        )}
      </div>
    </section>
  );
}
