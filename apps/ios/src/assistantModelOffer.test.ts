import { describe, expect, it } from 'vite-plus/test';
import { type AssistantDownload, createAssistantDownload } from './assistantDownload.ts';
import { offerOnce, offerQuestion, type OfferChoice } from './assistantModelOffer.ts';

const WIFI = { constrained: false, expensive: false, satisfied: true };

describe('offerQuestion', () => {
  it('says the size and asks, with Wi-Fi as the way', () => {
    const question = offerQuestion(833_592_288, WIFI);
    expect(question.title).toBe('Download the Assistant?');
    expect(question.message).toContain('one-time download of 834 MB, over Wi-Fi');
    expect(question.buttons.map((button) => button.text)).toEqual(['Not Now', 'Download']);
    expect(question.buttons[0]).toMatchObject({ choice: 'decline', style: 'cancel' });
  });

  it('says a new version is an update where an earlier one was downloaded', () => {
    const question = offerQuestion(833_592_288, WIFI, { update: true });
    expect(question.title).toBe('Update the Assistant?');
    expect(question.message).toContain('new version of the Assistant’s model');
    expect(question.message).toContain('834 MB, over Wi-Fi');
    expect(question.buttons.map((button) => button.text)).toEqual(['Not Now', 'Update']);
  });

  it('offers mobile data on mobile data, saying it comes out of the plan', () => {
    const question = offerQuestion(833_592_288, { ...WIFI, expensive: true });
    expect(question.message).toContain('downloads the 834 MB from your data plan');
    expect(question.buttons.map((button) => [button.text, button.choice])).toEqual([
      ['Not Now', 'decline'],
      ['Download on Wi-Fi', 'wifi'],
      ['Use Mobile Data', 'mobile'],
    ]);
  });

  it('says so in Low Data Mode, and lets the person download anyway', () => {
    const question = offerQuestion(833_592_288, { ...WIFI, constrained: true });
    expect(question.message).toContain('Low Data Mode is on');
    expect(question.buttons.at(-1)).toEqual({ choice: 'mobile', text: 'Download Now' });
  });
});

describe('offerOnce', () => {
  it('asks once a launch, only where the model was never answered, and hands the answer on', async () => {
    const calls: Array<string> = [];
    const store: AssistantDownload = {
      ...createAssistantDownload({ reason: 'fixture', supported: false }),
      agree: async (network) => {
        calls.push(`agree ${network}`);
      },
      decline: () => calls.push('decline'),
      getState: () => ({ kind: 'unasked' }),
      network: () => WIFI,
      size: () => 1000,
    };
    const asked: Array<string> = [];
    const answerWith =
      (choice: OfferChoice) => (question: { title: string }, answer: (c: OfferChoice) => void) => {
        asked.push(question.title);
        answer(choice);
      };
    offerOnce(store, answerWith('wifi'));
    offerOnce(store, answerWith('decline'));
    expect(asked).toEqual(['Download the Assistant?']);
    expect(calls).toEqual(['agree wifi']);
  });
});
