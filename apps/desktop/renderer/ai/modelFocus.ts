/**
 * Re-check the model when the window regains focus (Apple Intelligence is
 * switched on in System Settings) and when the provider changes
 * (Settings › AI Model picked another model while this window was open).
 */
export const onWindowFocus = (onActive: () => void): (() => void) => {
  window.addEventListener('focus', onActive);
  const unsubscribe = window.calendarBridge.onModelProviderChanged(onActive);
  return () => {
    window.removeEventListener('focus', onActive);
    unsubscribe();
  };
};
