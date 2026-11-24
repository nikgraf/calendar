import { describe, expect, it } from 'vite-plus/test';
import { flowSteps, phrasesModelStatus, speechModelStatus } from './assistantFlow.ts';

const SIZE = 833_592_288;
const iPhone = { device: 'iPhone', network: undefined, size: SIZE } as const;

describe('flowSteps', () => {
  it('goes from what is said to a saved event, naming the model each step runs on', () => {
    const steps = flowSteps('Mac');
    expect(steps.map((step) => step.model)).toEqual([undefined, 'speech', 'phrases', undefined]);
    expect(steps[3]?.text).toContain('click Save');
    expect(flowSteps('iPhone')[3]?.text).toContain('tap Save');
  });
});

describe('phrasesModelStatus', () => {
  it('says where the model stands in one line, with the notice’s action', () => {
    expect(phrasesModelStatus({ kind: 'unasked' }, iPhone)).toEqual({
      action: { kind: 'download', label: 'Download (834 MB)' },
      line: 'Not on this iPhone yet.',
    });
    expect(phrasesModelStatus({ kind: 'ready', path: '/m.gguf' }, iPhone)).toEqual({
      line: 'On this iPhone · 834 MB',
    });
    expect(
      phrasesModelStatus({ kind: 'downloading', received: 1, total: 4 }, iPhone),
    ).toMatchObject({ progress: 25 });
    expect(phrasesModelStatus({ kind: 'failed', message: 'Offline.' }, iPhone)).toEqual({
      action: { kind: 'retry', label: 'Try Again' },
      line: 'The download did not finish: Offline.',
    });
  });
});

describe('speechModelStatus', () => {
  const options = { device: 'iPhone', network: undefined } as const;

  it('offers the download while it is on and not here', () => {
    expect(speechModelStatus({ files: { kind: 'absent' }, on: true }, options)).toEqual({
      action: { kind: 'download', label: 'Download (712 MB)' },
      line: 'Not on this iPhone yet.',
    });
  });

  it('says it is off, and that its files stay while it is', () => {
    expect(speechModelStatus({ files: { kind: 'absent' }, on: false }, options)).toEqual({
      line: 'Off. Dictation uses Apple’s words as they are.',
    });
    expect(
      speechModelStatus({ files: { bytes: 712_000_000, kind: 'ready' }, on: false }, options),
    ).toEqual({ line: 'On this iPhone · switched off in Dictation' });
    expect(
      speechModelStatus({ files: { bytes: 712_000_000, kind: 'ready' }, on: true }, options),
    ).toEqual({ line: 'On this iPhone · 712 MB' });
  });
});
