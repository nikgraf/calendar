/**
 * The models, libraries and typeface the apps ship or download whose
 * licences ask to be credited, as both apps show them (iOS: Settings ›
 * Acknowledgements; Mac: the About panel) and THIRD_PARTY_NOTICES.md at the
 * repository's root lists them with their licence texts
 * (`acknowledgements.test.ts` keeps the two together). An entry here is a
 * notice the licence requires: CC BY 4.0 asks for the creator, the licence
 * and what was changed; MIT, Apache-2.0 and the OFL for the copyright
 * notice and the licence's text with every copy.
 */
export type LicenceId = 'Apache-2.0' | 'CC-BY-4.0' | 'MIT' | 'OFL-1.1';

export interface Acknowledgement {
  /** Who made it, as their notice names them. */
  readonly by: string;
  /** What was done to it before it reached the app, where anything was (CC BY asks). */
  readonly changes?: string;
  /** The copyright line its licence asks to keep, where it has one. */
  readonly copyright?: string;
  readonly licence: LicenceId;
  readonly name: string;
  readonly url: string;
  /** What it does in Solunivo. */
  readonly what: string;
}

export const LICENCES: Readonly<
  Record<LicenceId, { readonly name: string; readonly url: string }>
> = {
  'Apache-2.0': {
    name: 'Apache License 2.0',
    url: 'https://www.apache.org/licenses/LICENSE-2.0',
  },
  'CC-BY-4.0': {
    name: 'Creative Commons Attribution 4.0',
    url: 'https://creativecommons.org/licenses/by/4.0/',
  },
  MIT: { name: 'MIT License', url: 'https://opensource.org/license/mit' },
  'OFL-1.1': { name: 'SIL Open Font License 1.1', url: 'https://openfontlicense.org' },
};

export const ACKNOWLEDGEMENTS: ReadonlyArray<Acknowledgement> = [
  {
    by: 'moondream',
    changes:
      'Post-trained by moondream from NVIDIA’s Parakeet TDT 0.6B v3; converted to Core ML by FluidInference (FluidInference/parakeet-ultra-coreml).',
    licence: 'CC-BY-4.0',
    name: 'Parakeet Ultra',
    url: 'https://huggingface.co/moondream/parakeet-ultra',
    what: 'The speech recogniser dictation reads each phrase with (Settings › Dictation).',
  },
  {
    by: 'NVIDIA',
    licence: 'CC-BY-4.0',
    name: 'Parakeet TDT 0.6B v3',
    url: 'https://huggingface.co/nvidia/parakeet-tdt-0.6b-v3',
    what: 'The model Parakeet Ultra was trained from.',
  },
  {
    by: 'NVIDIA',
    changes: 'Converted to Core ML by FluidInference (FluidInference/parakeet-ctc-110m-coreml).',
    licence: 'CC-BY-4.0',
    name: 'Parakeet TDT-CTC 110M',
    url: 'https://huggingface.co/nvidia/parakeet-tdt_ctc-110m',
    what: 'Listens for the names of the people and places in your calendar while Parakeet reads.',
  },
  {
    by: 'FluidInference',
    licence: 'Apache-2.0',
    name: 'FluidAudio',
    url: 'https://github.com/FluidInference/FluidAudio',
    what: 'Runs Parakeet on the device’s Neural Engine.',
  },
  {
    by: 'Qwen, Alibaba Cloud',
    changes: 'Fine-tuned for calendar phrases (github.com/nikgraf/calendar-models).',
    licence: 'Apache-2.0',
    name: 'Qwen3.5 0.8B',
    url: 'https://huggingface.co/Qwen/Qwen3.5-0.8B',
    what: 'The base of the Assistant’s model.',
  },
  {
    by: 'The ggml authors',
    copyright: 'Copyright (c) 2023-2026 The ggml authors',
    licence: 'MIT',
    name: 'llama.cpp',
    url: 'https://github.com/ggml-org/llama.cpp',
    what: 'Runs the Assistant’s model.',
  },
  {
    by: 'Jhen-Jie Hong',
    copyright: 'Copyright (c) 2023 Jhen-Jie Hong',
    licence: 'MIT',
    name: 'llama.rn',
    url: 'https://github.com/mybigday/llama.rn',
    what: 'llama.cpp in the iPhone app.',
  },
  {
    by: 'The Inter Project Authors',
    copyright: 'Copyright (c) 2016 The Inter Project Authors (https://github.com/rsms/inter)',
    licence: 'OFL-1.1',
    name: 'Inter',
    url: 'https://rsms.me/inter/',
    what: 'The typeface of the Mac app and the website.',
  },
];

/** One entry as a line of credits: "Parakeet Ultra by moondream (Creative Commons Attribution 4.0)". */
export const creditLine = (entry: Acknowledgement): string =>
  `${entry.name} by ${entry.by} (${LICENCES[entry.licence].name})`;
