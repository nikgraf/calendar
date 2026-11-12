import type { CaptureSource, ModelStatus } from '@calendar/ai';
import {
  changedLine,
  describeDraft,
  type Draft,
  draftCalendarKey,
  draftListKey,
  type FieldChange,
  type QuickAddItem,
  stepSummary,
  useQuickAddModel,
  type useThreadEditor,
  versionLabel,
} from '@calendar/app-state';
import type { CalendarInfo, TaskListInfo } from '@calendar/core';
import { type ReactNode, type RefObject, useEffect, useRef } from 'react';
import { desktopLanguageModel } from '../../ai/desktopModel.ts';
import { desktopSpeech } from '../../ai/desktopSpeech.ts';
import { modelUnavailableCopy } from '../../ai/modelUnavailableCopy.ts';
import { requestCodeImport } from '../../settingsCode/codeImportRequests.ts';
import { Button } from '../../ui/Button.tsx';
import { MicIcon, SparkleIcon, SpinnerIcon } from '../../ui/icons.tsx';
import {
  captureSourceOf,
  isCapturableInPhrase,
  readPaste,
  settingsCodeOf,
} from '../captureClipboard.ts';
import { AssistantCard } from './AssistantCard.tsx';
import { DraftQuestions } from './DraftQuestions.tsx';

/** The empty field of a new item; the e2e specs find the field by it. */
export const QUICK_ADD_PLACEHOLDER = 'Lunch with Sarah tomorrow at 1';
/** The field once there is something to change. */
const CHANGE_PLACEHOLDER = 'Type a change';

/** What was said or typed, as the conversation shows it: on the right, in the ink of an action. */
const SAID =
  'ml-6 max-w-full self-end rounded-2xl rounded-br-sm bg-primary px-3 py-1.5 text-sm break-words text-on-primary select-text';

/**
 * A step that is not the one on show, in one line: which version it left,
 * what it did, and the way to it. Later ones — stepped back over — are
 * dimmed.
 */
function VersionRow({
  dimmed = false,
  disabled,
  label,
  onRestore,
  position,
  summary,
}: {
  readonly dimmed?: boolean;
  readonly disabled: boolean;
  readonly label: string;
  readonly onRestore: () => void;
  readonly position: number;
  readonly summary: string;
}) {
  return (
    <div
      className={`flex items-center gap-2 rounded-control bg-fill py-1 pr-1 pl-3 ${
        dimmed ? 'opacity-55' : ''
      }`}
      data-position={position}
      data-testid="assistant-version"
    >
      <div className="min-w-0 flex-1">
        <p className="text-[11px] font-semibold tracking-wide text-ink-secondary uppercase">
          {label}
        </p>
        <p className="truncate text-sm text-ink-secondary" title={summary}>
          {summary}
        </p>
      </div>
      <Button
        data-testid="assistant-restore"
        disabled={disabled}
        onClick={onRestore}
        size="sm"
        variant="ghost"
      >
        Restore
      </Button>
    </div>
  );
}

/**
 * The assistant's view of the editor: a conversation. What was said or
 * typed is on the right; each answer is the item as a card, with what the
 * step changed marked and the old value struck through, and under the
 * newest whatever the assistant has to ask (`DraftQuestions`). Steps
 * that are not on show are one line each with Restore, which puts that
 * version on show (the panel's footer then offers "Use this"); an edit
 * made by hand in the form is listed among them. At the bottom the field
 * to type into and the microphone: a phrase is sent with Return, or by a
 * pause while dictating (hands-free: one click listens until the
 * microphone is clicked, the field typed into or the form edited by
 * hand). What it is doing, and why a phrase failed, is said in a line
 * under the field; a failed phrase stays in the field to fix. Without the
 * model the view says why and offers Retry; the form is one tab away.
 */
export function AssistantView({
  active,
  availability,
  banner,
  calendars,
  editKey,
  editor,
  fallbackDate,
  focusSignal,
  initialText,
  note,
  onApply,
  onCapture,
  onEdit,
  onPhrase,
  taskLists,
  timeZone,
}: {
  /** The view is the one on show: it takes the focus and follows its newest row only then. */
  readonly active: boolean;
  readonly availability: {
    readonly checking: boolean;
    readonly retry: () => void;
    readonly status: ModelStatus | null;
  };
  /** Above the conversation: the lesson's frame. */
  readonly banner?: ReactNode;
  readonly calendars: ReadonlyArray<CalendarInfo>;
  /** Moves at each edit made by hand in the form: hands-free dictation ends. */
  readonly editKey: number;
  readonly editor: ReturnType<typeof useThreadEditor>;
  /** Undated phrases land on this day (the editor's). */
  readonly fallbackDate: string;
  /** ⌘K focuses the field: bumped per press. */
  readonly focusSignal: number;
  /** What the field holds on open, selected (the Create lesson's phrase). */
  readonly initialText?: string | undefined;
  /** A caveat about the drafts (the pasted text was cut short). */
  readonly note?: string | undefined;
  readonly onApply: (item: QuickAddItem) => void;
  /** A pasted email or image is not a phrase: it goes to capture. */
  readonly onCapture: (source: CaptureSource) => void;
  /** To the form, on the same draft. */
  readonly onEdit: () => void;
  readonly onPhrase: (text: string) => Promise<string | undefined>;
  readonly taskLists: ReadonlyArray<TaskListInfo>;
  readonly timeZone: string;
}) {
  const { assistant, drafts, labels, previewing, steps } = editor;
  const inputRef = useRef<HTMLInputElement>(null);
  const threadRef = useRef<HTMLDivElement>(null);
  const quick = useQuickAddModel({
    editKey,
    fallbackDate,
    hold: editor.applying,
    initialText,
    model: desktopLanguageModel,
    // An older step on show: nothing is listened for, and listening ends.
    off: previewing,
    onApply,
    onPhrase,
    speech: desktopSpeech,
    timeZone,
  });
  const unavailable = availability.status !== null && availability.status !== 'ready';
  const unavailableCopy = modelUnavailableCopy(availability.status);
  const { busy, phrase } = quick;

  // Focused on open and on ⌘K — not while the model is missing, when the
  // form's title is the first thing to type into.
  useEffect(() => {
    if (active && !unavailable) {
      inputRef.current?.focus();
      inputRef.current?.select();
    }
  }, [active, focusSignal, unavailable]);

  // The newest row is the one to read: the conversation follows it.
  const rows = steps.line.length;
  useEffect(() => {
    const thread = threadRef.current;
    if (active && thread) {
      thread.scrollTop = thread.scrollHeight;
    }
  }, [active, rows, steps.at, busy, drafts.length]);

  const answer = (
    <StepAnswer
      calendars={calendars}
      editor={editor}
      note={note}
      onEdit={onEdit}
      taskLists={taskLists}
    />
  );

  const started = steps.of > 0;
  return (
    <>
      <div
        className="flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto px-4 pt-1 pb-2"
        data-testid="assistant-thread"
        ref={threadRef}
      >
        {banner}
        {unavailable ? (
          <div
            className="flex flex-col items-start gap-2 rounded-control bg-fill p-3"
            data-testid="assistant-unavailable"
          >
            <p className="text-sm text-ink-secondary">{unavailableCopy.long}</p>
            <Button disabled={availability.checking} onClick={availability.retry} size="sm">
              Retry
            </Button>
          </div>
        ) : null}
        {!started && assistant === 'new' && !busy && !unavailable ? (
          <div className="flex flex-1 flex-col items-center justify-center gap-1 px-4 text-center">
            <SparkleIcon className="text-ink-secondary" size={18} />
            <p className="text-sm font-medium">Say or type what to add</p>
            <p className="text-xs text-ink-secondary">
              “Lunch with Sarah tomorrow at 1”, then change it the same way: “at 12:30”, “invite
              Tom”.
            </p>
          </div>
        ) : null}
        {assistant === 'saved' && steps.at > 0 ? (
          <VersionRow
            disabled={steps.locked}
            label="As saved"
            onRestore={() => steps.show(0)}
            position={0}
            summary={(() => {
              const saved = steps.line[0]?.before.drafts[0];
              return saved ? describeDraft(saved) : '';
            })()}
          />
        ) : null}
        {steps.at === 0 && (assistant === 'saved' || !started) ? answer : null}
        {steps.at === 0 && assistant === 'new' && started ? (
          <p className="text-xs text-ink-secondary" data-testid="assistant-start">
            Before the first step: nothing yet.
          </p>
        ) : null}
        {steps.line.map((line) => (
          <div className="flex flex-col gap-2" key={line.step.id}>
            {line.step.kind === 'phrase' ? (
              <p
                className={`${SAID} ${line.dimmed ? 'opacity-55' : ''}`}
                data-testid="assistant-said"
              >
                {line.step.utterance}
              </p>
            ) : null}
            {line.position === steps.at ? (
              answer
            ) : (
              <VersionRow
                dimmed={line.dimmed}
                disabled={steps.locked}
                label={versionLabel(line)}
                onRestore={() => steps.show(line.position)}
                position={line.position}
                summary={stepSummary(line, labels)}
              />
            )}
          </div>
        ))}
        {busy && phrase.trim() !== '' ? (
          <p className={`${SAID} opacity-60`} data-testid="assistant-pending">
            {phrase}
          </p>
        ) : null}
      </div>

      <AssistantInput
        hasDrafts={drafts.length > 0}
        inputRef={inputRef}
        onCapture={onCapture}
        previewing={previewing}
        quick={quick}
        status={availability.status}
      />
    </>
  );
}

/**
 * The step on show as cards: the draft the form shows open, with what the
 * step changed marked — unless the step made it, when all of it is new
 * and nothing is "changed" — and any other draft as a line that brings
 * it into the form; under them, while it is the newest step, what the
 * assistant has to ask.
 */
function StepAnswer({
  calendars,
  editor,
  note,
  onEdit,
  taskLists,
}: {
  readonly calendars: ReadonlyArray<CalendarInfo>;
  readonly editor: ReturnType<typeof useThreadEditor>;
  readonly note: string | undefined;
  readonly onEdit: () => void;
  readonly taskLists: ReadonlyArray<TaskListInfo>;
}) {
  const { assistant, drafts, eventModel, focused, marks, previewing, steps, taskModel } = editor;
  /** Where a draft goes, by name and color: the focused one where the form points. */
  const containerOf = (draft: Draft, index: number) => {
    if (draft.item.kind === 'task') {
      const key = index === focused ? taskModel.listKey : draftListKey(draft, taskLists, '');
      const list = taskLists.find((each) => `${each.accountId}:${each.id}` === key);
      return { color: list?.colorHex, name: list?.title };
    }
    const key =
      index === focused
        ? eventModel.calendarKey
        : draftCalendarKey(draft, calendars, eventModel.calendarKey);
    const calendar = calendars.find((each) => `${each.accountId}:${each.id}` === key);
    return { color: calendar?.colorHex, name: calendar?.summary };
  };
  const shown = steps.line[steps.at - 1];
  const versionLabel =
    steps.at === 0 ? (assistant === 'saved' ? 'As saved' : '') : `Version ${String(steps.at)}`;
  return (
    <>
      {drafts.map((draft, index) => {
        if (index !== focused) {
          return (
            <button
              className="flex items-center gap-2 rounded-control bg-fill px-3 py-1.5 text-left text-sm hover:bg-hairline disabled:cursor-default"
              data-draft={draft.id}
              data-testid="assistant-draft"
              disabled={!editor.settled}
              key={draft.id}
              onClick={() => editor.switchFocus(index)}
              type="button"
            >
              <span className="min-w-0 flex-1 truncate font-medium">
                {draft.item.prefill.title || 'Untitled'}
              </span>
              <span className="shrink-0 text-xs text-ink-secondary">{describeDraft(draft)}</span>
            </button>
          );
        }
        const container = containerOf(draft, index);
        const existed = shown?.before.drafts.some((each) => each.id === draft.id) ?? false;
        const changes = existed ? (marks?.changes ?? []) : [];
        return (
          <AssistantCard
            changes={changes}
            color={container.color}
            container={container.name}
            draft={draft}
            footer={
              previewing ? null : <CardFooter changes={changes} onEdit={onEdit} steps={steps} />
            }
            key={draft.id}
            label={versionLabel}
          />
        );
      })}
      {previewing ? null : <DraftQuestions editor={editor} note={note} />}
    </>
  );
}

/** Under the newest card: what the step changed, in a line, then Undo (a step back) and Edit (the form). */
function CardFooter({
  changes,
  onEdit,
  steps,
}: {
  readonly changes: ReadonlyArray<FieldChange>;
  readonly onEdit: () => void;
  readonly steps: ReturnType<typeof useThreadEditor>['steps'];
}) {
  return (
    <div className="flex items-center justify-between gap-2 border-t border-hairline pt-1.5">
      <span className="min-w-0 truncate text-xs text-ink-secondary" data-testid="assistant-changed">
        {changedLine(changes)}
      </span>
      <div className="flex shrink-0 gap-1">
        {steps.at > 0 ? (
          <Button
            data-testid="assistant-undo"
            disabled={steps.locked}
            onClick={steps.back}
            size="sm"
            variant="ghost"
          >
            Undo
          </Button>
        ) : null}
        <Button data-testid="assistant-edit" onClick={onEdit} size="sm" variant="ghost">
          Edit
        </Button>
      </div>
    </div>
  );
}

/**
 * What the field is doing, or why the last phrase failed (until the field
 * is typed into — while listening, until the next phrase begins).
 */
const inputStatus = ({
  busy,
  error,
  voice,
}: Pick<ReturnType<typeof useQuickAddModel>, 'busy' | 'error' | 'voice'>): {
  readonly text: string;
  readonly tone: 'error' | 'hint';
} | null => {
  if (voice === 'preparing') {
    return { text: 'Preparing dictation…', tone: 'hint' };
  }
  if (voice === 'transcribing') {
    return { text: 'Transcribing…', tone: 'hint' };
  }
  if (busy) {
    return { text: 'Reading…', tone: 'hint' };
  }
  if (error) {
    return { text: error, tone: 'error' };
  }
  return voice === 'recording'
    ? { text: 'Listening… pause to send, click the mic to stop', tone: 'hint' }
    : null;
};

/**
 * The field to type a phrase into and the microphone beside it, with a
 * line under them for what is going on. Return sends; a paste that is an
 * email or an image goes to capture, a settings code to its import.
 */
function AssistantInput({
  hasDrafts,
  inputRef,
  onCapture,
  previewing,
  quick,
  status: modelStatus,
}: {
  readonly hasDrafts: boolean;
  readonly inputRef: RefObject<HTMLInputElement | null>;
  readonly onCapture: (source: CaptureSource) => void;
  readonly previewing: boolean;
  readonly quick: ReturnType<typeof useQuickAddModel>;
  readonly status: ModelStatus | null;
}) {
  const {
    busy,
    dismissError,
    endVoice,
    handsFree,
    heard,
    phrase,
    setPhrase,
    submit,
    toggleVoice,
    voice,
    voiceAvailable,
  } = quick;
  const unavailable = modelStatus !== null && modelStatus !== 'ready';
  const unavailableCopy = modelUnavailableCopy(modelStatus);
  const working = busy || voice === 'transcribing';
  const status = inputStatus(quick);
  const placeholder = unavailable
    ? unavailableCopy.short
    : previewing
      ? 'An earlier step is on show'
      : hasDrafts
        ? CHANGE_PLACEHOLDER
        : QUICK_ADD_PLACEHOLDER;
  return (
    <div className="flex shrink-0 flex-col gap-1 px-4 pt-1 pb-2" data-testid="quick-add">
      <div className="flex items-center gap-2">
        <label
          className={`flex h-10 min-w-0 flex-1 items-center gap-2 rounded-control bg-fill pr-2 pl-3 text-sm has-[input:focus]:ring-2 has-[input:focus]:ring-focus ${
            unavailable ? 'opacity-70' : ''
          }`}
          title={unavailable ? unavailableCopy.long : undefined}
        >
          <input
            aria-label="Quick add"
            className="min-w-0 flex-1 truncate bg-transparent text-ink outline-none placeholder:text-ink-secondary disabled:cursor-default"
            data-testid="quick-add-input"
            disabled={unavailable || previewing}
            onChange={(input) => {
              // Typed into while dictating: the user took over.
              if (handsFree) {
                endVoice();
              }
              // Typed into after a phrase failed: a new phrase, from the key pressed.
              dismissError();
              setPhrase(input.target.value);
            }}
            onKeyDown={(key) => {
              if (key.key === 'Enter') {
                key.preventDefault();
                if (!busy) {
                  void submit();
                }
              } else if (key.key === 'Escape') {
                key.currentTarget.blur();
              }
            }}
            onPaste={(event) => {
              const pasted = readPaste(event.clipboardData);
              // A settings code is one line, so it would paste as a phrase.
              const code = settingsCodeOf(pasted);
              if (code) {
                event.preventDefault();
                event.currentTarget.blur();
                requestCodeImport(code);
                return;
              }
              if (!isCapturableInPhrase(pasted)) {
                return;
              }
              event.preventDefault();
              event.currentTarget.blur();
              void captureSourceOf(pasted).then((source) => {
                if (source) {
                  onCapture(source);
                }
              });
            }}
            placeholder={placeholder}
            // Read-only while a phrase is read, not disabled: the field keeps
            // the focus, so the next phrase is typed without a click.
            readOnly={busy}
            ref={inputRef}
            // Being read, the words are in the conversation above.
            value={busy ? '' : phrase}
          />
          {working ? <SpinnerIcon className="shrink-0" size={14} strokeWidth={2.25} /> : null}
        </label>
        {voiceAvailable && !unavailable ? (
          <button
            aria-label={handsFree ? 'Stop dictating' : 'Dictate'}
            aria-pressed={handsFree}
            className={`inline-flex size-10 shrink-0 items-center justify-center rounded-full transition-colors disabled:cursor-default disabled:opacity-40 ${
              handsFree
                ? 'bg-danger text-on-danger'
                : 'bg-primary text-on-primary hover:bg-primary-hover'
            }`}
            data-listening={voice === 'recording' ? (heard ? 'speech' : 'quiet') : undefined}
            data-testid="quick-add-mic"
            // On, it always answers (to stop); off, not while a typed phrase
            // is read or an older step is on show.
            disabled={!handsFree && (working || previewing)}
            onClick={toggleVoice}
            title={handsFree ? 'Stop dictating' : 'Dictate'}
            type="button"
          >
            {/* Hearing speech: the microphone breathes. */}
            <MicIcon className={heard ? 'motion-safe:animate-pulse' : ''} size={18} />
          </button>
        ) : null}
      </div>
      <p
        className={`min-h-4 truncate text-xs ${
          status?.tone === 'error' ? 'text-danger' : 'text-ink-secondary'
        }`}
        data-testid="quick-add-status"
        role="status"
        title={status?.text}
      >
        {status?.text ?? ''}
      </p>
    </div>
  );
}
