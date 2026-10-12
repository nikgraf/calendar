import type { ModelStatus } from '@calendar/ai';
import type { ModelStatusReply } from '../backend.ts';
import { lastModelStatusReply } from './desktopModel.ts';

interface Copy {
  /** A sentence: the field's tooltip, the capture dialog's error. */
  readonly long: string;
  /** Fits the quick-add field's placeholder. */
  readonly short: string;
}

const GENERIC: Copy = {
  long: "The on-device model is unavailable — Solunivo's AI features need macOS 26 with Apple Intelligence enabled.",
  short: 'Model unavailable',
};

const COPY: Readonly<Record<Exclude<ModelStatus, 'ready'>, Copy>> = {
  disabled: {
    long: "Solunivo's AI features need Apple Intelligence — turn it on in System Settings › Apple Intelligence & Siri. Siri's language has to match the Mac's, or it stays off.",
    short: 'Turn on Apple Intelligence',
  },
  'missing-module': GENERIC,
  'not-ready': {
    long: 'macOS is still downloading the Apple Intelligence model. The AI features turn on by themselves once it is ready.',
    short: 'Model downloading…',
  },
  unavailable: GENERIC,
  unsupported: {
    long: "Solunivo's AI features need macOS 26 on a Mac that supports Apple Intelligence.",
    short: 'Not available on this Mac',
  },
};

const SERVER_NAME: Record<'ollama' | 'openai', string> = {
  ollama: 'Ollama',
  openai: 'The model server',
};

/** What a served model's failure means, in words that name the server and the fix. */
const servedCopy = (reply: ModelStatusReply): Copy | undefined => {
  if (reply.provider === 'apple') {
    return undefined;
  }
  const server = SERVER_NAME[reply.provider];
  const where = reply.endpoint ? ` at ${reply.endpoint}` : '';
  if (reply.detail === 'authRejected') {
    return {
      long: `${server}${where} refused the API key — set the right one in Settings › General.`,
      short: 'API key refused',
    };
  }
  if (reply.detail === 'endpointUnreachable') {
    return {
      long: `${server}${where} is not reachable — start it, or choose Apple Intelligence in Settings › General.`,
      short: `${server} unreachable`,
    };
  }
  if (reply.detail === 'modelMissing') {
    return {
      long:
        reply.model && reply.model !== ''
          ? `${server}${where} does not have "${reply.model}" — pull it there, or pick one it lists in Settings › General.`
          : `No model is picked for ${server}${where} — choose one in Settings › General.`,
      short: 'Model not on the server',
    };
  }
  return {
    long: `${server}${where} could not answer — check it, or choose Apple Intelligence in Settings › General.`,
    short: `${server} unavailable`,
  };
};

/**
 * What the AI entry points say when the model cannot run: the reason the
 * system gave, so the user knows whether to switch something on, wait, or
 * stop looking. Generic while the check is still out. A served model
 * names its server and the fix instead of Apple Intelligence.
 */
export const modelUnavailableCopy = (
  status: ModelStatus | null,
  reply: ModelStatusReply | null = lastModelStatusReply(),
): Copy => {
  if (status === null || status === 'ready') {
    return GENERIC;
  }
  return (reply && servedCopy(reply)) ?? COPY[status];
};
