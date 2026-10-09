import { describe, expect, it } from 'vite-plus/test';
import type { CaptureParse } from './capture.ts';
import { fixtureTextRecognizer, makeFixtureLanguageModel } from './fixtureModel.ts';
import type { LanguageModel, ModelStatus } from './model.ts';
import { ModelUnavailableError } from './model.ts';
import { parseCapture, type CapturePhase } from './parseCapture.ts';
import type { TextRecognizer } from './textRecognition.ts';

const CONTEXT = { referenceDate: '2026-09-20', timeZone: 'Europe/Vienna' };

const fakeModel = (
  parse: CaptureParse | (() => never),
  { status = 'ready' }: { status?: ModelStatus } = {},
): LanguageModel & { prompts: Array<string> } => {
  const prompts: Array<string> = [];
  return {
    generateJson: async ({ prompt }) => {
      prompts.push(prompt);
      return typeof parse === 'function' ? parse() : parse;
    },
    prompts,
    status: async () => status,
  };
};

const recognizing = (text: string | (() => never)): TextRecognizer => ({
  recognizeText: async () => (typeof text === 'function' ? text() : text),
});

const toBase64 = (text: string) => btoa(String.fromCharCode(...new TextEncoder().encode(text)));

describe('parseCapture', () => {
  it('turns a pasted mail into drafts and reports the phases', async () => {
    const model = fakeModel({
      events: [
        { date: '2026-09-22', startTime: '10:00', title: 'Planning' },
        { date: '2026-09-24', title: 'Offsite' },
      ],
    });
    const phases: Array<CapturePhase> = [];
    const result = await parseCapture(
      { model, recognizer: recognizing('') },
      { kind: 'text', text: 'Planning Tue 10:00, offsite Thursday' },
      { ...CONTEXT, onPhase: (phase) => phases.push(phase) },
    );
    expect(result).toMatchObject({ kind: 'parsed', truncated: false });
    expect(result.kind === 'parsed' && result.drafts.map((draft) => draft.title)).toEqual([
      'Planning',
      'Offsite',
    ]);
    expect(phases).toEqual(['extracting']);
    expect(model.prompts[0]).toContain('Planning Tue 10:00, offsite Thursday');
  });

  it('reads an image first, then extracts', async () => {
    const model = fakeModel({ events: [{ date: '2026-10-03', title: 'Concert' }] });
    const phases: Array<CapturePhase> = [];
    const result = await parseCapture(
      { model, recognizer: recognizing('CONCERT\nOct 3') },
      { image: { base64: 'ignored', kind: 'base64' }, kind: 'image' },
      { ...CONTEXT, onPhase: (phase) => phases.push(phase) },
    );
    expect(result.kind).toBe('parsed');
    expect(phases).toEqual(['reading', 'extracting']);
    expect(model.prompts[0]).toContain('CONCERT\nOct 3');
  });

  it('rejects an unreadable or empty image without calling the model', async () => {
    const model = fakeModel({ events: [] });
    const image = { image: { kind: 'uri', uri: 'file:///x.png' }, kind: 'image' } as const;
    const failing = recognizing(() => {
      throw new Error('vision');
    });
    await expect(parseCapture({ model, recognizer: failing }, image, CONTEXT)).resolves.toEqual({
      kind: 'rejected',
      reason: "That image couldn't be read.",
    });
    await expect(
      parseCapture({ model, recognizer: recognizing('  \n') }, image, CONTEXT),
    ).resolves.toEqual({ kind: 'rejected', reason: 'No text was found in the image.' });
    expect(model.prompts).toEqual([]);
  });

  it('rejects blank text, a throwing model and a nonsense answer', async () => {
    const recognizer = recognizing('');
    await expect(
      parseCapture({ model: fakeModel({}), recognizer }, { kind: 'text', text: ' \n ' }, CONTEXT),
    ).resolves.toMatchObject({ kind: 'rejected' });
    const thrower = fakeModel(() => {
      throw new Error('timeout');
    });
    await expect(
      parseCapture({ model: thrower, recognizer }, { kind: 'text', text: 'Lunch' }, CONTEXT),
    ).resolves.toMatchObject({ kind: 'rejected' });
    await expect(
      parseCapture(
        { model: fakeModel('nope' as never), recognizer },
        { kind: 'text', text: 'Lunch' },
        CONTEXT,
      ),
    ).resolves.toMatchObject({ kind: 'rejected' });
  });

  it('rejects when nothing dated survives normalization', async () => {
    const result = await parseCapture(
      { model: fakeModel({ events: [{ title: 'Someday' }] }), recognizer: recognizing('') },
      { kind: 'text', text: 'Let us meet someday' },
      CONTEXT,
    );
    expect(result).toEqual({ kind: 'rejected', reason: 'No dated events were found.' });
  });

  it('throws when the model is unavailable, before any OCR', async () => {
    const recognizer = recognizing(() => {
      throw new Error('must not be called');
    });
    await expect(
      parseCapture(
        { model: fakeModel({}, { status: 'unavailable' }), recognizer },
        { image: { base64: 'x', kind: 'base64' }, kind: 'image' },
        CONTEXT,
      ),
    ).rejects.toBeInstanceOf(ModelUnavailableError);
  });

  it('flags truncation', async () => {
    const result = await parseCapture(
      {
        model: fakeModel({ events: [{ date: '2026-09-22', title: 'Planning' }] }),
        recognizer: recognizing(''),
      },
      { kind: 'text', text: 'Planning Tuesday\n'.repeat(1000) },
      CONTEXT,
    );
    expect(result).toMatchObject({ kind: 'parsed', truncated: true });
  });

  it('runs end to end on the fixture model and recognizer', async () => {
    const lines = ['Standup | +1 | 09:00-09:15 | Room 4', 'Offsite | 2026-10-02', 'ignored'];
    const result = await parseCapture(
      { model: makeFixtureLanguageModel(), recognizer: fixtureTextRecognizer },
      { image: { base64: toBase64(lines.join('\n')), kind: 'base64' }, kind: 'image' },
      CONTEXT,
    );
    expect(result.kind === 'parsed' && result.drafts).toEqual([
      {
        date: '2026-09-21',
        endTime: '09:15',
        isAllDay: false,
        location: 'Room 4',
        startTime: '09:00',
        title: 'Standup',
      },
      {
        date: '2026-10-02',
        endTime: '01:00',
        isAllDay: true,
        startTime: '00:00',
        title: 'Offsite',
      },
    ]);
  });
});
