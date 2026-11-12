import { useEffect, useState } from 'react';
import { Keyboard, type KeyboardEvent, useWindowDimensions } from 'react-native';
import { keyboardOverlap } from './keyboardInset.ts';

/**
 * The room the keyboard takes at the bottom of the window, as it moves:
 * what a bar that must stay above it pads itself by. The editor is a
 * page sheet on an iPhone in portrait, so its bottom edge is the
 * window's and the overlap is the keyboard's own height. The layout
 * that follows is animated with the keyboard's curve, so the bar rides
 * up with it.
 */
export const useKeyboardInset = (): number => {
  const { height } = useWindowDimensions();
  const [inset, setInset] = useState(0);
  useEffect(() => {
    const moved = (event: KeyboardEvent) => {
      Keyboard.scheduleLayoutAnimation(event);
      setInset(keyboardOverlap(event.endCoordinates.screenY, height));
    };
    const changed = Keyboard.addListener('keyboardWillChangeFrame', moved);
    const hidden = Keyboard.addListener('keyboardWillHide', (event) => {
      Keyboard.scheduleLayoutAnimation(event);
      setInset(0);
    });
    return () => {
      changed.remove();
      hidden.remove();
    };
  }, [height]);
  return inset;
};
