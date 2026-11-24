import {
  type AssistantDevice,
  type AssistantModelState,
  type NetworkReading,
  noticeCopy,
  sizeLabel,
} from './assistantModel.ts';
import {
  PARAKEET_BYTES,
  type ParakeetAction,
  parakeetCopy,
  type ParakeetState,
} from './parakeetModel.ts';

/**
 * How the Assistant works, as the Create lesson's "How it works" and
 * Settings › Assistant (iOS) / AI Model (Mac) show it: one promise (only
 * models on this device), the four steps from what is said to a saved
 * event, and the two models by the names people meet them under — the
 * phrases model (the Assistant's own) and the speech model (Parakeet).
 */

/** Which of the two downloads a step runs on. */
export type FlowModel = 'phrases' | 'speech';

export interface FlowStep {
  readonly model?: FlowModel;
  readonly text: string;
  readonly title: string;
}

export interface FlowModelInfo {
  readonly bytes: number;
  /** What it does, in a few words. */
  readonly does: string;
  readonly name: string;
  /** The speech model: dictation works without it, as Apple's recogniser writes it. */
  readonly optional: boolean;
}

export const FLOW_MODELS: Readonly<Record<FlowModel, Omit<FlowModelInfo, 'bytes'>>> = {
  phrases: {
    does: 'Turns what you say into an event',
    name: 'Phrases Model',
    optional: false,
  },
  speech: {
    does: 'Spells the names and places you say',
    name: 'Speech Model',
    optional: true,
  },
};

export const flowSteps = (device: AssistantDevice): ReadonlyArray<FlowStep> => [
  {
    text: `Apple’s speech recognition on this ${device} writes your words as you talk. Typing works too.`,
    title: 'You say what you want',
  },
  {
    model: 'speech',
    text: 'It listens to the finished phrase again and spells the people and places from your calendar and contacts.',
    title: 'The speech model checks the words',
  },
  {
    model: 'phrases',
    text: 'Trained on calendar phrases, it fills in the title, day, time, place and guests.',
    title: 'The phrases model makes the event',
  },
  {
    text: `The answer is a card. Nothing is saved until you ${device === 'iPhone' ? 'tap' : 'click'} Save.`,
    title: 'You check and save',
  },
];

/** Where the two downloads come from, and the one lookup that leaves the device. */
export const FLOW_DOWNLOADS =
  'The models download once: the phrases model from GitHub, the speech model from Hugging Face. A place you name is looked up in Apple Maps.';

/** The two models with their sizes, phrases first. */
export const flowModels = (
  assistantBytes: number,
): ReadonlyArray<FlowModelInfo & { readonly model: FlowModel }> => [
  { ...FLOW_MODELS.phrases, bytes: assistantBytes, model: 'phrases' },
  { ...FLOW_MODELS.speech, bytes: PARAKEET_BYTES, model: 'speech' },
];

/** One model's row in Settings: where it stands, its progress, and the one action it offers. */
export interface FlowModelStatus {
  readonly action?: { readonly kind: 'download' | 'mobile' | 'retry'; readonly label: string };
  readonly line: string;
  readonly progress?: number;
}

/** The phrases model's row: as the Assistant's notice words it, in one line. */
export const phrasesModelStatus = (
  state: AssistantModelState,
  options: {
    readonly device: AssistantDevice;
    readonly network: NetworkReading | undefined;
    readonly size: number;
  },
): FlowModelStatus => {
  const { action, lines, progress } = noticeCopy(state, options);
  const line = ((): string => {
    switch (state.kind) {
      case 'ready':
        return `On this ${options.device} · ${sizeLabel(options.size)}`;
      case 'unasked':
        return state.update === true
          ? 'A new version is ready.'
          : `Not on this ${options.device} yet.`;
      case 'declined':
        return `Not on this ${options.device} yet.`;
      default:
        return lines[0] ?? '';
    }
  })();
  return {
    ...(action === undefined
      ? {}
      : {
          action: {
            kind: action.kind,
            label:
              action.kind === 'download' ? `Download (${sizeLabel(options.size)})` : action.label,
          },
        }),
    line,
    ...(progress === undefined ? {} : { progress }),
  };
};

/** The speech model's row: `parakeetCopy`'s line, and Off once it is switched off. */
export const speechModelStatus = (
  state: ParakeetState,
  options: { readonly device: AssistantDevice; readonly network: NetworkReading | undefined },
): FlowModelStatus => {
  const copy = parakeetCopy(state.files, options);
  if (!state.on && state.files.kind !== 'ready' && state.files.kind !== 'unsupported') {
    return { line: 'Off. Dictation uses Apple’s words as they are.' };
  }
  const action: ParakeetAction | undefined = copy.action;
  return {
    ...(action === undefined
      ? {}
      : {
          action: {
            kind: action.kind,
            label:
              action.kind === 'download' ? `Download (${sizeLabel(PARAKEET_BYTES)})` : action.label,
          },
        }),
    line:
      state.files.kind === 'absent'
        ? `Not on this ${options.device} yet.`
        : state.files.kind === 'ready' && !state.on
          ? `On this ${options.device} · switched off in Dictation`
          : copy.line,
    ...(copy.progress === undefined ? {} : { progress: copy.progress }),
  };
};
