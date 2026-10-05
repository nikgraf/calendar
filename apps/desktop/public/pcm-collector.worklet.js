// Dictation's audio worklet: hands each block of the mic's mono channel
// to the page (renderer/ai/desktopSpeech.ts). A file of the bundle rather
// than a blob: URL, so the renderer's script-src can stay 'self'.
registerProcessor(
  'pcm-collector',
  class extends AudioWorkletProcessor {
    process(inputs) {
      const channel = inputs[0]?.[0];
      if (channel) {
        this.port.postMessage(channel.slice(0));
      }
      return true;
    }
  },
);
