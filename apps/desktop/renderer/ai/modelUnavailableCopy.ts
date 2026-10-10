import type { ModelStatus } from '@calendar/ai';

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

/**
 * What the AI entry points say when the model cannot run: the reason the
 * system gave, so the user knows whether to switch something on, wait, or
 * stop looking. Generic while the check is still out.
 */
export const modelUnavailableCopy = (status: ModelStatus | null): Copy =>
  status === null || status === 'ready' ? GENERIC : COPY[status];
