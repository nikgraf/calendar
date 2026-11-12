import { AppState } from 'react-native';

/**
 * Apple Intelligence is switched on in Settings, which means leaving the
 * app: re-check on the way back so what needs the model appears without
 * a relaunch. Model downloads finish out of process too.
 */
export const onAppActive = (onActive: () => void): (() => void) => {
  const subscription = AppState.addEventListener('change', (next) => {
    if (next === 'active') {
      onActive();
    }
  });
  return () => subscription.remove();
};
