import type {
  AssistantModelState,
  NetworkReading,
  UnsupportedReason,
} from './assistantDownload.ts';
import { sizeLabel } from './assistantModelManifest.ts';

/**
 * What the Assistant's notice and Diagnostics say about the Assistant's
 * model while it is not on this iPhone yet, and the one action each state
 * offers (`AssistantModelNotice.tsx`).
 */

const UNSUPPORTED: Readonly<Record<UnsupportedReason, string>> = {
  fixture: 'The Assistant runs on the test model in this build.',
  memory: 'The Assistant needs an iPhone with 8 GB of memory. The form still makes an event.',
  module: 'This build cannot download the Assistant’s model; the next TestFlight build can.',
  runtime: 'This build cannot run the Assistant’s model; the next TestFlight build can.',
  simulator: 'The simulator downloads the Assistant’s model only from a file it is pointed at.',
  unpublished: 'The Assistant’s model is not available yet. The form still makes an event.',
};

const percentOf = (received: number, total: number): number =>
  total > 0 ? Math.min(100, Math.floor((received / total) * 100)) : 0;

/** The notice's words for a state, and the one action it offers. */
export const noticeCopy = (
  state: AssistantModelState,
  {
    network,
    size,
  }: { readonly network: NetworkReading | undefined; readonly size: number | undefined },
): {
  readonly action?: { readonly kind: 'download' | 'mobile' | 'retry'; readonly label: string };
  readonly lines: ReadonlyArray<string>;
  readonly progress?: number;
} => {
  const sized = size === undefined ? '' : ` (${sizeLabel(size)})`;
  const soon = 'The Assistant will be available soon. You can use the Form meanwhile.';
  switch (state.kind) {
    case 'unasked':
    case 'declined':
      return {
        action: { kind: 'download', label: `Download${sized}` },
        lines: [
          `The Assistant reads what you say with a model that runs on this iPhone. It needs a one-time download${size === undefined ? '' : ` of ${sizeLabel(size)}`}, over Wi-Fi.`,
        ],
      };
    case 'waiting':
      if (state.for === 'network') {
        return { lines: ['Waiting for a connection to download the Assistant’s model.', soon] };
      }
      return network?.expensive === true || network?.constrained !== true
        ? {
            action: { kind: 'mobile', label: `Use Mobile Data${sized}` },
            lines: ['The Assistant’s model downloads when this iPhone is on Wi-Fi.', soon],
          }
        : {
            action: { kind: 'mobile', label: `Download Now${sized}` },
            lines: ['The Assistant’s model waits while Low Data Mode is on.', soon],
          };
    case 'downloading': {
      const percent = percentOf(state.received, state.total);
      return {
        lines: [`Downloading the Assistant’s model: ${String(percent)} %`, soon],
        progress: percent,
      };
    }
    case 'verifying':
      return { lines: ['Checking the downloaded model…', soon], progress: 100 };
    case 'failed':
      return {
        action: { kind: 'retry', label: 'Try Again' },
        lines: [`The download did not finish: ${state.message}`],
      };
    case 'unsupported':
      return { lines: [UNSUPPORTED[state.reason]] };
    case 'ready':
      return { lines: [] };
  }
};
