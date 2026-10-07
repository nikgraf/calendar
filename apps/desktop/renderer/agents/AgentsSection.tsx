import type { AgentPolicy, CalendarLevel, TaskListLevel } from '@calendar/agent/policy';
import {
  CALENDAR_LEVELS,
  calendarOverride,
  cliExample,
  GUESTS_LABEL,
  GUESTS_OPTIONS,
  LEVEL_LABEL,
  mcpConfigSnippet,
  TASK_LIST_LEVELS,
  taskListOverride,
  withCalendarLevel,
  withTaskListLevel,
} from '@calendar/agent/policyEdit';
import type { AgentRequestView, AgentsState, AgentView } from '@calendar/agent/view';
import { useAccounts, useCalendars, useTaskLists } from '@calendar/app-state';
import {
  type Account,
  isAppleCalendarAccount,
  isAppleRemindersAccount,
  isCalendarWritable,
  isTaskListWritable,
} from '@calendar/core';
import { useEffect, useState } from 'react';
import { ARM_DELAY_MS } from './AgentApprovalDialog.tsx';
import { useAgentsState } from './useAgentsState.ts';

const BUTTON =
  'rounded-lg border border-hairline-strong px-3 py-1.5 text-sm hover:bg-surface-subtle disabled:opacity-50';
const SELECT = 'w-44 shrink-0 rounded-md border border-hairline bg-surface px-1.5 py-1 text-xs';
const DEFAULT = '__default__';

const shortPath = (path: string): string => path.replace(/^\/Users\/[^/]+/, '~');

const timeLabel = (epochMs: number): string =>
  new Date(epochMs).toLocaleString(undefined, {
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    month: 'short',
  });

const accountLabel = (account: Account | undefined): string => {
  if (!account) {
    return 'Unknown account';
  }
  if (isAppleCalendarAccount(account)) {
    return 'Apple Calendar';
  }
  if (isAppleRemindersAccount(account)) {
    return 'Apple Reminders';
  }
  return account.email;
};

const STATUS_LABEL: Record<AgentRequestView['status'], string> = {
  approved: 'Running…',
  blocked: 'Blocked by the grant',
  denied: 'Declined by you',
  done: 'Done',
  expired: 'Expired',
  failed: 'Failed',
  pending: 'Waiting for you',
};

/** A line of text the user copies (a token, a config snippet). */
function Copyable({ label, testId, text }: { label: string; testId: string; text: string }) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // The text is selectable: copying by hand still works.
    }
  };
  return (
    <div className="mt-2">
      <div className="flex items-center justify-between">
        <span className="text-xs font-medium text-ink-secondary">{label}</span>
        <button className="text-xs text-primary hover:underline" onClick={copy} type="button">
          {copied ? 'Copied' : 'Copy'}
        </button>
      </div>
      <pre
        className="mt-1 max-h-72 overflow-auto rounded-lg bg-neutral-900 p-2 text-xs break-all whitespace-pre-wrap text-neutral-100 select-text"
        data-testid={testId}
      >
        {text}
      </pre>
    </div>
  );
}

/** Shown once, right after a token was created or replaced. */
function TokenPanel({
  command,
  name,
  onDone,
  token,
}: {
  command: AgentsState['command'];
  name: string;
  onDone: () => void;
  token: string;
}) {
  return (
    <div
      className="mt-3 rounded-lg border border-amber-200 bg-amber-50 p-3"
      data-testid="agent-token-panel"
    >
      <p className="text-sm font-medium text-amber-900">Token for {name}</p>
      <p className="mt-1 text-xs text-amber-800">
        Copy it now — Solunivo keeps only a fingerprint and cannot show it again. Anyone with this
        token can do what this agent may do.
      </p>
      <Copyable label="Token" testId="agent-token" text={token} />
      <Copyable
        label="MCP configuration"
        testId="agent-mcp-config"
        text={mcpConfigSnippet(command, token)}
      />
      <Copyable
        label="Or from a shell"
        testId="agent-cli-example"
        text={cliExample(command, token)}
      />
      <button className={`${BUTTON} mt-3`} onClick={onDone} type="button">
        Done
      </button>
    </div>
  );
}

function LevelSelect<Level extends string>({
  ariaLabel,
  defaultLevel,
  levels,
  onChange,
  testId,
  value,
}: {
  ariaLabel: string;
  /** Present on a per-item select: the level "Default" currently stands for. */
  defaultLevel?: Level;
  levels: ReadonlyArray<Level>;
  onChange: (level: Level | undefined) => void;
  testId: string;
  value: Level | undefined;
}) {
  return (
    <select
      aria-label={ariaLabel}
      className={SELECT}
      data-testid={testId}
      onChange={(event) =>
        onChange(event.target.value === DEFAULT ? undefined : (event.target.value as Level))
      }
      value={value ?? DEFAULT}
    >
      {defaultLevel === undefined ? null : (
        <option value={DEFAULT}>Default ({LEVEL_LABEL[defaultLevel as CalendarLevel]})</option>
      )}
      {levels.map((level) => (
        <option key={level} value={level}>
          {LEVEL_LABEL[level as CalendarLevel]}
        </option>
      ))}
    </select>
  );
}

/** The grant editor of one agent: defaults, per-calendar and per-list levels, guests, contacts. */
function GrantEditor({
  agent,
  persist,
}: {
  agent: AgentView;
  persist: (policy: AgentPolicy) => void;
}) {
  const accounts = useAccounts();
  const calendars = useCalendars();
  const taskLists = useTaskLists();
  // Edits build on the last edit, not on the last state the main process
  // sent back: two quick changes must not overwrite each other.
  const [policy, setPolicy] = useState(agent.policy);
  const save = (next: AgentPolicy) => {
    setPolicy(next);
    persist(next);
  };
  const accountOf = (id: string) => accounts.find((account) => account.id === id);

  return (
    <div className="mt-3 space-y-4 border-t border-hairline pt-3" data-testid="agent-grant">
      <div>
        <div className="flex items-center justify-between gap-2">
          <h4 className="text-sm font-medium">Calendars</h4>
          <LevelSelect
            ariaLabel="Default access to calendars"
            levels={CALENDAR_LEVELS}
            onChange={(level) => save({ ...policy, calendarDefault: level ?? 'none' })}
            testId="agent-calendar-default"
            value={policy.calendarDefault}
          />
        </div>
        <ul className="mt-2 space-y-1">
          {calendars.map((calendar) => {
            const target = { accountId: calendar.accountId, calendarId: calendar.id };
            // A calendar the provider keeps read-only can never be written to.
            const levels = isCalendarWritable(calendar)
              ? CALENDAR_LEVELS
              : CALENDAR_LEVELS.filter((level) => level !== 'ask' && level !== 'write');
            return (
              <li
                className="flex items-center gap-2 text-sm"
                key={`${calendar.accountId}:${calendar.id}`}
              >
                <span
                  className="inline-block size-3 shrink-0 rounded-full"
                  style={{ backgroundColor: calendar.colorHex }}
                />
                <span className="min-w-0 flex-1 truncate">
                  {calendar.summary}
                  <span className="ml-1 text-xs text-ink-secondary">
                    {accountLabel(accountOf(calendar.accountId))}
                  </span>
                </span>
                {calendar.isVisible ? (
                  <LevelSelect
                    ariaLabel={`Access to ${calendar.summary}`}
                    defaultLevel={policy.calendarDefault}
                    levels={levels}
                    onChange={(level) => save(withCalendarLevel(policy, target, level))}
                    testId={`agent-calendar-${calendar.id}`}
                    value={calendarOverride(policy, target)}
                  />
                ) : (
                  <span className="text-xs text-ink-secondary">
                    Hidden — not available to agents
                  </span>
                )}
              </li>
            );
          })}
        </ul>
      </div>

      <div>
        <div className="flex items-center justify-between gap-2">
          <h4 className="text-sm font-medium">Task lists</h4>
          <LevelSelect<TaskListLevel>
            ariaLabel="Default access to task lists"
            levels={TASK_LIST_LEVELS}
            onChange={(level) => save({ ...policy, taskListDefault: level ?? 'none' })}
            testId="agent-list-default"
            value={policy.taskListDefault}
          />
        </div>
        <ul className="mt-2 space-y-1">
          {taskLists.map((list) => {
            const target = { accountId: list.accountId, taskListId: list.id };
            const levels = isTaskListWritable(list)
              ? TASK_LIST_LEVELS
              : TASK_LIST_LEVELS.filter((level) => level !== 'ask' && level !== 'write');
            return (
              <li className="flex items-center gap-2 text-sm" key={`${list.accountId}:${list.id}`}>
                <span className="min-w-0 flex-1 truncate">
                  {list.title}
                  <span className="ml-1 text-xs text-ink-secondary">
                    {accountLabel(accountOf(list.accountId))}
                  </span>
                </span>
                {list.isVisible ? (
                  <LevelSelect<TaskListLevel>
                    ariaLabel={`Access to ${list.title}`}
                    defaultLevel={policy.taskListDefault}
                    levels={levels}
                    onChange={(level) => save(withTaskListLevel(policy, target, level))}
                    testId={`agent-list-${list.id}`}
                    value={taskListOverride(policy, target)}
                  />
                ) : (
                  <span className="text-xs text-ink-secondary">
                    Hidden — not available to agents
                  </span>
                )}
              </li>
            );
          })}
        </ul>
      </div>

      <div className="space-y-2">
        <label className="flex items-center justify-between gap-2 text-sm">
          <span>
            Events with guests
            <span className="block text-xs text-ink-secondary">
              Creating, changing or deleting them emails the guests.
            </span>
          </span>
          <select
            aria-label="Events with guests"
            className={SELECT}
            data-testid="agent-guests"
            onChange={(event) =>
              save({ ...policy, guests: event.target.value as AgentPolicy['guests'] })
            }
            value={policy.guests}
          >
            {GUESTS_OPTIONS.map((option) => (
              <option key={option} value={option}>
                {GUESTS_LABEL[option]}
              </option>
            ))}
          </select>
        </label>
        <label className="flex items-center gap-2 text-sm">
          <input
            checked={policy.contacts}
            data-testid="agent-contacts"
            onChange={(event) => save({ ...policy, contacts: event.target.checked })}
            type="checkbox"
          />
          Search my contacts
        </label>
      </div>
    </div>
  );
}

function RequestRow({ request }: { request: AgentRequestView }) {
  return (
    <li className="text-sm" data-testid="agent-activity-row">
      <div className="flex items-baseline justify-between gap-2">
        <span className="min-w-0 truncate">
          <span className="font-medium">{request.agentName}</span> · {request.summary.title}
        </span>
        <span className="shrink-0 text-xs text-ink-secondary">{timeLabel(request.createdAt)}</span>
      </div>
      <div
        className={`text-xs ${request.status === 'done' ? 'text-ink-secondary' : 'text-amber-700'}`}
      >
        {STATUS_LABEL[request.status]}
        {request.error ? ` — ${request.error.message}` : ''}
      </div>
    </li>
  );
}

/**
 * Settings → Agents: who may reach the calendar from outside the app, and
 * with what. Grants exist only here — nothing an agent can call, and
 * nothing in the settings file, creates an agent or widens one.
 */
export function AgentsSection() {
  const state = useAgentsState();
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [openId, setOpenId] = useState<string | null>(null);
  const [fresh, setFresh] = useState<{ name: string; token: string } | null>(null);

  if (!state) {
    return null;
  }

  const attempt = async (task: () => Promise<void>) => {
    setBusy(true);
    setNotice(null);
    try {
      await task();
    } catch (error) {
      setNotice(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  };

  const create = () =>
    attempt(async () => {
      const created = await window.calendarBridge.agentsCreate(name.trim());
      setName('');
      setFresh({ name: created.agent.name, token: created.token });
      setOpenId(created.agent.id);
    });

  const rotate = (agent: AgentView) =>
    attempt(async () => {
      const rotated = await window.calendarBridge.agentsRotate(agent.id);
      if (rotated) {
        setFresh({ name: agent.name, token: rotated.token });
      }
    });

  const remove = (agent: AgentView) =>
    attempt(async () => {
      await window.calendarBridge.agentsRemove(agent.id);
      setOpenId(null);
    });

  const decide = (request: AgentRequestView, decision: 'approve' | 'deny') =>
    attempt(async () => {
      await window.calendarBridge.agentsDecide(request.id, decision);
    });
  // Answering one request moves the next into its place under the
  // pointer; every row disarms whenever the list changes (PendingChoice).
  const pendingIds = state.pending.map((request) => request.id).join(' ');

  return (
    <section className="rounded-popover bg-surface-subtle p-4" data-testid="agents-section">
      <h2 className="font-medium">Agents</h2>
      <p className="mt-1 text-sm text-ink-secondary">
        Let other agents on this Mac read and change your calendars and tasks through Solunivo, over
        MCP or the command line. Each agent gets its own token and only the access you give it here.
      </p>

      {state.agents.length === 0 ? null : (
        <ul className="mt-3 space-y-3">
          {state.agents.map((agent) => (
            <li
              className="rounded-lg border border-hairline p-3"
              data-agent-name={agent.name}
              data-testid="agent-row"
              key={agent.id}
            >
              <div className="flex items-center gap-3">
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-medium">{agent.name}</p>
                  <p className="text-xs text-ink-secondary">
                    {agent.lastUsedAt === undefined
                      ? 'Never connected'
                      : `Last used ${timeLabel(agent.lastUsedAt)}`}
                  </p>
                </div>
                <button
                  aria-expanded={openId === agent.id}
                  className="text-xs text-primary hover:underline"
                  data-testid="agent-edit"
                  onClick={() => setOpenId(openId === agent.id ? null : agent.id)}
                  type="button"
                >
                  {openId === agent.id ? 'Close' : 'Access…'}
                </button>
                <button
                  className="text-xs text-primary hover:underline disabled:opacity-50"
                  data-testid="agent-rotate"
                  disabled={busy}
                  onClick={() => void rotate(agent)}
                  type="button"
                >
                  New token
                </button>
                <button
                  aria-label={`Remove ${agent.name}`}
                  className="text-xs text-red-600 hover:underline disabled:opacity-50"
                  data-testid="agent-remove"
                  disabled={busy}
                  onClick={() => void remove(agent)}
                  type="button"
                >
                  Remove
                </button>
              </div>
              {openId === agent.id ? (
                <GrantEditor
                  agent={agent}
                  key={agent.id}
                  persist={(policy) =>
                    void attempt(async () => {
                      await window.calendarBridge.agentsUpdate(agent.id, { policy });
                    })
                  }
                />
              ) : null}
            </li>
          ))}
        </ul>
      )}

      {fresh ? (
        <TokenPanel
          command={state.command}
          name={fresh.name}
          onDone={() => setFresh(null)}
          token={fresh.token}
        />
      ) : null}

      <form
        className="mt-3 flex gap-2"
        onSubmit={(event) => {
          event.preventDefault();
          if (name.trim() !== '') {
            void create();
          }
        }}
      >
        <input
          aria-label="Agent name"
          className="w-full rounded-lg border border-hairline bg-surface px-3 py-1.5 text-sm"
          data-testid="agent-name"
          maxLength={60}
          onChange={(event) => setName(event.target.value)}
          placeholder="Name, e.g. Hermes"
          value={name}
        />
        <button
          className={`${BUTTON} shrink-0`}
          data-testid="agent-create"
          disabled={busy || name.trim() === ''}
          type="submit"
        >
          Add agent
        </button>
      </form>

      {state.pending.length > 0 ? (
        <div className="mt-4">
          <h3 className="text-sm font-medium">Waiting for you</h3>
          <ul className="mt-2 space-y-2">
            {state.pending.map((request) => (
              <li
                className="rounded-lg border border-amber-200 bg-amber-50 p-2 text-sm"
                data-testid="agent-pending-row"
                key={request.id}
              >
                <p>
                  <span className="font-medium">{request.agentName}</span> · {request.summary.title}
                </p>
                <ul className="mt-1 max-h-40 overflow-y-auto text-xs break-words text-ink-secondary">
                  {request.summary.lines.map((line) => (
                    <li key={line}>{line}</li>
                  ))}
                </ul>
                <PendingChoice
                  busy={busy}
                  // Remounted whenever the list changes, so it starts disarmed.
                  key={pendingIds}
                  onApprove={() => void decide(request, 'approve')}
                  onDecline={() => void decide(request, 'deny')}
                />
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      {state.activity.length > 0 ? (
        <div className="mt-4">
          <h3 className="text-sm font-medium">Recent activity</h3>
          <ul className="mt-2 max-h-48 space-y-2 overflow-y-auto" data-testid="agent-activity">
            {state.activity.map((request) => (
              <RequestRow key={request.id} request={request} />
            ))}
          </ul>
        </div>
      ) : null}

      <p className="mt-3 text-xs text-ink-secondary" data-testid="agents-status">
        {state.error
          ? `Not listening: ${state.error}`
          : state.listening
            ? `Listening on ${shortPath(state.socketPath)} — this Mac only.`
            : 'Not listening: there are no agents.'}{' '}
        A grant limits agents that connect here; it does not protect your data from other software
        running as you.
      </p>
      {notice ? (
        <p className="mt-2 text-xs text-amber-700" role="status">
          {notice}
        </p>
      ) : null}
    </section>
  );
}

/**
 * Decline / Approve for one waiting request, inert for ARM_DELAY_MS after
 * it mounts — as in the approval dialog. Keyed by the whole list: when an
 * answered request leaves and the next slides up, the second click of a
 * double click lands on buttons that are not armed yet.
 */
function PendingChoice({
  busy,
  onApprove,
  onDecline,
}: {
  busy: boolean;
  onApprove: () => void;
  onDecline: () => void;
}) {
  const [armed, setArmed] = useState(false);
  useEffect(() => {
    const timer = setTimeout(() => setArmed(true), ARM_DELAY_MS);
    return () => clearTimeout(timer);
  }, []);
  return (
    <div className="mt-2 flex gap-2">
      <button
        className={BUTTON}
        data-testid="agent-pending-decline"
        disabled={busy || !armed}
        onClick={onDecline}
        type="button"
      >
        Decline
      </button>
      <button
        className="rounded-lg bg-primary px-3 py-1.5 text-sm font-medium text-on-primary hover:bg-primary-hover disabled:opacity-50"
        data-testid="agent-pending-approve"
        disabled={busy || !armed}
        onClick={onApprove}
        type="button"
      >
        Approve
      </button>
    </div>
  );
}
