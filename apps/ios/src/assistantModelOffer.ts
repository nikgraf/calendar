import { type NetworkReading, sizeLabel } from '@calendar/ai';
import type { AssistantDownload } from './assistantDownload.ts';

/**
 * The question at app start (App Review guideline 4.2.3: say the size and
 * ask before downloading what the app needs). Asked once a launch, only
 * while the model was never answered for its version; "Not Now" is kept,
 * and the Assistant then offers the download itself. The transfer goes
 * over Wi-Fi without Low Data Mode unless the person picks mobile data
 * here or later.
 */

export type OfferChoice = 'decline' | 'mobile' | 'wifi';

export interface OfferQuestion {
  readonly buttons: ReadonlyArray<{
    readonly choice: OfferChoice;
    readonly style?: 'cancel' | undefined;
    readonly text: string;
  }>;
  readonly message: string;
  readonly title: string;
}

const NOT_NOW = { choice: 'decline', style: 'cancel', text: 'Not Now' } as const;

/** The question's words for a model of `bytes`, and a third button where the network now would hold the transfer. */
export const offerQuestion = (
  bytes: number,
  network: NetworkReading | undefined,
): OfferQuestion => {
  const size = sizeLabel(bytes);
  const title = 'Download the Assistant?';
  const base = `The Assistant reads what you say with a model that runs on this iPhone, so your words stay on it. It is a one-time download of ${size}, over Wi-Fi.`;
  if (network?.expensive === true) {
    return {
      buttons: [
        NOT_NOW,
        { choice: 'wifi', text: 'Download on Wi-Fi' },
        { choice: 'mobile', text: 'Use Mobile Data' },
      ],
      message: `${base}\n\nThis iPhone is on mobile data now. “Use Mobile Data” downloads the ${size} from your data plan.`,
      title,
    };
  }
  if (network?.constrained === true) {
    return {
      buttons: [
        NOT_NOW,
        { choice: 'wifi', text: 'Download Later' },
        { choice: 'mobile', text: 'Download Now' },
      ],
      message: `${base}\n\nLow Data Mode is on, so it waits until it is off, or downloads now with “Download Now”.`,
      title,
    };
  }
  return { buttons: [NOT_NOW, { choice: 'wifi', text: 'Download' }], message: base, title };
};

let asked = false;

/** Asks once a launch, where the model was never answered for its version. */
export const offerOnce = (
  store: AssistantDownload,
  ask: (question: OfferQuestion, answer: (choice: OfferChoice) => void) => void,
): void => {
  const bytes = store.size();
  if (asked || bytes === undefined || store.getState().kind !== 'unasked') {
    return;
  }
  asked = true;
  ask(offerQuestion(bytes, store.network()), (choice) => {
    if (choice === 'decline') {
      store.decline();
      return;
    }
    void store.agree(choice);
  });
};
