import { FLOW_DOWNLOADS, FLOW_MODELS, type FlowModel, flowSteps, sizeLabel } from '@calendar/ai';

/**
 * How the Assistant works, as numbered steps down a rail: what is said,
 * the speech model, the phrases model, the card to save (`flowSteps`). A
 * step that runs on a download carries that model's size (raised in the
 * lesson's banner, which is drawn in `fill`). `compact` for the Create
 * lesson's "How it works", with where the downloads come from under it;
 * full size in Settings › AI Model, which says that itself.
 */
export function AssistantFlow({
  compact = false,
  sizes,
}: {
  readonly compact?: boolean;
  /** Each model's size, for its tag. */
  readonly sizes: Readonly<Record<FlowModel, number>>;
}) {
  const steps = flowSteps('Mac');
  return (
    <div data-testid="assistant-flow">
      <ol>
        {steps.map((step, index) => {
          const last = index === steps.length - 1;
          const model = step.model === undefined ? undefined : FLOW_MODELS[step.model];
          return (
            <li
              className="flex gap-2.5"
              data-testid={`assistant-flow-step-${String(index + 1)}`}
              key={step.title}
            >
              <div className="flex shrink-0 flex-col items-center">
                <span
                  aria-hidden
                  className={`flex items-center justify-center rounded-full bg-primary font-semibold text-on-primary ${compact ? 'size-4 text-[10px]' : 'size-5 text-[11px]'}`}
                >
                  {index + 1}
                </span>
                {last ? null : <span aria-hidden className="my-0.5 w-0.5 flex-1 bg-hairline" />}
              </div>
              <div className={`min-w-0 flex-1 ${last ? '' : compact ? 'pb-2' : 'pb-3.5'}`}>
                <p className={`font-medium text-ink ${compact ? 'text-xs' : 'text-sm'}`}>
                  {step.title}
                </p>
                <p className={`text-ink-secondary ${compact ? 'text-xs' : 'mt-0.5 text-sm'}`}>
                  {step.text}
                </p>
                {model === undefined || step.model === undefined ? null : (
                  <span
                    className={`mt-1 inline-block rounded-full px-2 py-0.5 text-[11px] font-medium text-ink-secondary ${compact ? 'bg-surface-raised' : 'bg-fill'}`}
                  >
                    {sizeLabel(sizes[step.model])}
                    {model.optional ? ' · optional' : ''}
                  </span>
                )}
              </div>
            </li>
          );
        })}
      </ol>
      {compact ? <p className="mt-2 text-xs text-ink-secondary">{FLOW_DOWNLOADS}</p> : null}
    </div>
  );
}
