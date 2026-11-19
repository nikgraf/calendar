import { afterEach, describe, expect, it, vi } from 'vite-plus/test';

vi.mock('expo', () => ({
  requireNativeModule: () => {
    throw new Error("Cannot find native module 'SolunivoModelAvailability'");
  },
}));

const { createAppleLanguageModel } = await import('./appleModel.ts');

type AppleModel = Pick<
  (typeof import('@react-native-ai/apple'))['AppleFoundationModels'],
  'generateText' | 'getModelInfo'
>;

const schema = { properties: { title: { type: 'string' } }, type: 'object' };
const ask = { jsonSchema: schema, prompt: 'Lunch with Sarah' };
const modelWith = (generateText: AppleModel['generateText']) =>
  createAppleLanguageModel(() => ({
    generateText,
    getModelInfo: async () => ({ availability: 'available' }),
  }));

describe('Apple Foundation Models 0.13 generation', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('reads only text from the content envelope and sends the guided schema', async () => {
    const generateText = vi.fn<AppleModel['generateText']>().mockResolvedValue({
      content: [
        { id: 'reasoning-1', text: 'This is not JSON.', type: 'reasoning' },
        { text: '  {"title":', type: 'text' },
        { input: '{}', toolCallId: 'call-1', toolName: 'lookup', type: 'tool-call' },
        { text: '"Lunch"}  ', type: 'text' },
      ],
      usage: { inputTokens: 12, outputTokens: 8 },
    });
    const model = modelWith(generateText);
    await expect(model.generateJson(ask)).resolves.toEqual({ title: 'Lunch' });
    expect(generateText).toHaveBeenCalledWith([{ content: ask.prompt, role: 'user' }], {
      schema,
      temperature: 0,
    });
    await expect(model.status()).resolves.toBe('ready');
  });

  it.each([
    { content: [] },
    { content: [{ text: ' \n ', type: 'text' as const }] },
    { content: [{ id: 'reasoning-1', text: '{"title":"Lunch"}', type: 'reasoning' as const }] },
  ])('rejects a reply without answer text: %j', async ({ content }) => {
    const model = modelWith(async () => ({ content }));
    await expect(model.generateJson(ask)).rejects.toThrow('The model returned an empty response.');
  });

  it('passes through native failures and rejects invalid JSON', async () => {
    const failed = modelWith(async () => {
      throw new Error('Native generation failed');
    });
    await expect(failed.generateJson(ask)).rejects.toThrow('Native generation failed');
    const invalid = modelWith(async () => ({ content: [{ text: '{', type: 'text' }] }));
    await expect(invalid.generateJson(ask)).rejects.toBeInstanceOf(SyntaxError);
  });

  it('gives up on a generation that never answers', async () => {
    vi.useFakeTimers();
    const model = modelWith(() => new Promise<never>(() => {}));
    const rejected = expect(model.generateJson(ask)).rejects.toThrow('Generation timed out.');
    await vi.advanceTimersByTimeAsync(60_000);
    await rejected;
    expect(vi.getTimerCount()).toBe(0);
  });
});
