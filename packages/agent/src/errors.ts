import { Data } from 'effect';
import type { DeniedReason } from './policy.ts';

/**
 * The item does not exist — or lives somewhere the agent has no grant
 * for. The two are deliberately indistinguishable: a denial would confirm
 * that a hidden calendar or event is there.
 */
export class AgentNotFoundError extends Data.TaggedError('NotFound')<{
  readonly what: string;
}> {}

export class AgentPermissionDeniedError extends Data.TaggedError('PermissionDenied')<{
  readonly message: string;
  /** `userDenied`: the user turned an ask-first request down in the app. */
  readonly reason: 'contacts' | 'userDenied' | DeniedReason;
}> {}

export class AgentInvalidInputError extends Data.TaggedError('InvalidInput')<{
  readonly message: string;
}> {}

/** The provider cannot hold a field the agent sent — reported, never dropped. */
export class AgentUnsupportedError extends Data.TaggedError('Unsupported')<{
  readonly field: string;
  readonly provider: string;
}> {}

/** Too many calls, or too many requests waiting for approval. */
export class AgentLimitError extends Data.TaggedError('RateLimited')<{
  readonly message: string;
}> {}

/** Anything else the backend refused or failed at; `tag` is the backend error's tag. */
export class AgentFailedError extends Data.TaggedError('Failed')<{
  readonly message: string;
  readonly tag: string;
}> {}

export type AgentError =
  | AgentFailedError
  | AgentInvalidInputError
  | AgentLimitError
  | AgentNotFoundError
  | AgentPermissionDeniedError
  | AgentUnsupportedError;

/** What crosses the socket and is stored with a failed request. */
export interface AgentErrorJson {
  readonly code: AgentError['_tag'];
  readonly message: string;
}

export const agentErrorJson = (error: AgentError): AgentErrorJson => {
  switch (error._tag) {
    case 'NotFound': {
      return { code: error._tag, message: `${error.what} not found.` };
    }
    case 'Unsupported': {
      return {
        code: error._tag,
        message: `The ${error.provider} provider cannot store "${error.field}". Nothing was written.`,
      };
    }
    default: {
      return { code: error._tag, message: error.message };
    }
  }
};

/** A stored failure back as the error the agent's call fails with. */
export const agentErrorFromJson = (json: AgentErrorJson): AgentError => {
  switch (json.code) {
    case 'InvalidInput': {
      return new AgentInvalidInputError({ message: json.message });
    }
    case 'RateLimited': {
      return new AgentLimitError({ message: json.message });
    }
    case 'PermissionDenied': {
      return new AgentPermissionDeniedError({ message: json.message, reason: 'level' });
    }
    default: {
      // NotFound and Unsupported render their own message from fields the
      // stored form no longer has; keep the stored text verbatim instead.
      return new AgentFailedError({ message: json.message, tag: json.code });
    }
  }
};

const tagOf = (error: unknown): string =>
  typeof error === 'object' && error !== null && '_tag' in error && typeof error._tag === 'string'
    ? error._tag
    : 'UnknownError';

const AGENT_TAGS: ReadonlySet<string> = new Set([
  'Failed',
  'InvalidInput',
  'NotFound',
  'PermissionDenied',
  'RateLimited',
  'Unsupported',
]);

const isAgentError = (error: unknown): error is AgentError => AGENT_TAGS.has(tagOf(error));

/**
 * Backend failures as an agent sees them. Typed backend errors keep their
 * meaning; the rest carry the backend tag and no internals beyond the
 * error's own message.
 */
export const toAgentError = (error: unknown): AgentError => {
  if (isAgentError(error)) {
    return error;
  }
  const tag = tagOf(error);
  const fields = error as { readonly field?: unknown; readonly provider?: unknown };
  switch (tag) {
    case 'UnsupportedForProviderError': {
      return new AgentUnsupportedError({
        field: String(fields.field),
        provider: String(fields.provider),
      });
    }
    case 'EventNotFoundError': {
      return new AgentNotFoundError({ what: 'Event' });
    }
    case 'TaskNotFoundError': {
      return new AgentNotFoundError({ what: 'Task' });
    }
    case 'TaskListNotFoundError': {
      return new AgentNotFoundError({ what: 'Task list' });
    }
    case 'RecurringEditUnsupportedError': {
      return new AgentInvalidInputError({
        message:
          'This ref names a recurring series; list the events again and use the ref of an occurrence together with `scope`.',
      });
    }
    case 'NotAttendeeError': {
      return new AgentInvalidInputError({
        message: 'The user is not on the guest list of this event, so there is no RSVP to change.',
      });
    }
    default: {
      const message =
        error instanceof Error
          ? error.message
          : typeof error === 'object' && error !== null && 'message' in error
            ? String(error.message)
            : String(error);
      return new AgentFailedError({ message: message === '' ? tag : message, tag });
    }
  }
};
