import { TextRecognitionError, type TextRecognizer } from '@calendar/ai';

/**
 * The desktop TextRecognizer: Vision in the bundled Swift helper, reached
 * over the same preload IPC as the model. The renderer only ever holds the
 * pasted bytes, so a URI is refused here rather than turned into a file
 * read in the helper.
 */
export const desktopTextRecognizer: TextRecognizer = {
  recognizeText: async (image) => {
    if (image.kind !== 'base64') {
      throw new TextRecognitionError({ message: 'The desktop reads pasted bytes only.' });
    }
    const result = await window.calendarBridge.modelRecognizeText(image.base64);
    return result.text;
  },
};
