import { TextRecognitionError, type TextRecognizer } from '@calendar/ai';
import { loadOcrModule } from '../modules/solunivo-ocr/index.ts';

/**
 * The iOS TextRecognizer: Vision in the local Expo module
 * (apps/ios/modules/solunivo-ocr, the Swift shared with the desktop
 * helper). A shared image is a file in the app-group container, so it goes
 * over as a URI and never through JS. A dev client built before the module
 * existed reports the gap instead of crashing at import.
 */
export const iosTextRecognizer: TextRecognizer = {
  recognizeText: async (image) => {
    const native = loadOcrModule();
    if (!native) {
      throw new TextRecognitionError({
        message: 'Text recognition is not in this build — rebuild the dev client.',
      });
    }
    const result = (await native.invoke(
      'ocr.recognizeText',
      image.kind === 'uri' ? { uri: image.uri } : { imageBase64: image.base64 },
    )) as { readonly text?: unknown };
    return typeof result.text === 'string' ? result.text : '';
  },
};
