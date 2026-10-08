import type { EventRecord } from '@calendar/core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

type Callback = (...args: Array<unknown>) => void;

interface PanMock {
  readonly handlers: Record<string, Callback>;
  waitsFor: PanMock | null;
}

/** Every `Gesture.Pan()` the last render built, by the builder it returned. */
const pans = vi.hoisted(() => new Map<unknown, PanMock>());

vi.mock('react', async (importOriginal) => ({
  ...(await importOriginal<typeof import('react')>()),
  useLayoutEffect: () => {},
}));
vi.mock('react-native', () => ({
  Pressable: 'Pressable',
  StyleSheet: { create: <T,>(styles: T) => styles },
  Text: 'Text',
  View: 'View',
}));
vi.mock('react-native-gesture-handler', () => ({
  Gesture: {
    Pan: () => {
      const pan: PanMock = { handlers: {}, waitsFor: null };
      const builder: Record<string, (value: unknown) => unknown> = {
        activateAfterLongPress: () => builder,
        enabled: () => builder,
        requireExternalGestureToFail: (other) => {
          pan.waitsFor = pans.get(other) ?? null;
          return builder;
        },
      };
      for (const name of ['onEnd', 'onFinalize', 'onStart', 'onUpdate']) {
        builder[name] = (callback) => {
          pan.handlers[name] = callback as Callback;
          return builder;
        };
      }
      pans.set(builder, pan);
      return builder;
    },
  },
  GestureDetector: 'GestureDetector',
}));
vi.mock('react-native-reanimated', () => ({
  default: { View: 'Animated.View' },
  runOnJS: (callback: Callback) => callback,
  runOnUI: (callback: Callback) => callback,
  useAnimatedStyle: () => ({}),
  useSharedValue: <T,>(value: T) => ({ value }),
  withTiming: <T,>(value: T) => value,
}));
vi.mock('./theme.ts', () => ({ useEventTint: () => ({ fill: '#ffffff', text: '#000000' }) }));

const { DraggableEventBlock } = await import('./DraggableEventBlock.tsx');

/** Builds the block once and hands back its two pans' callbacks. */
const block = (onCommitResize: () => Promise<void>) => {
  pans.clear();
  DraggableEventBlock({
    color: '#3366ff',
    compact: true,
    event: { recurrence: null } as unknown as EventRecord,
    height: 56,
    left: 0,
    onCommitMove: () => Promise.resolve(),
    onCommitResize,
    onPress: () => {},
    readOnly: false,
    secondaryZones: [],
    timeZone: 'UTC',
    top: 0,
    width: '100%',
  });
  // The move pan is the one that waits for the resize to fail.
  const move = [...pans.values()].find((pan) => pan.waitsFor !== null)!;
  return { move: move.handlers, resize: move.waitsFor!.handlers };
};

describe('DraggableEventBlock', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('keeps a resize when the move pan waiting on it fails', () => {
    const onCommitResize = vi.fn(() => Promise.resolve());
    const { move, resize } = block(onCommitResize);

    resize['onStart']!();
    // The resize activating fails the move pan, which still finalizes.
    move['onFinalize']!({}, false);
    resize['onUpdate']!({ translationY: 28 });
    resize['onEnd']!({ translationY: 28 }, true);
    resize['onFinalize']!({}, true);

    expect(onCommitResize).toHaveBeenCalledWith(30);
  });

  it('commits nothing for a cancelled resize', () => {
    const onCommitResize = vi.fn(() => Promise.resolve());
    const { resize } = block(onCommitResize);

    resize['onStart']!();
    resize['onUpdate']!({ translationY: 28 });
    resize['onEnd']!({ translationY: 28 }, false);
    resize['onFinalize']!({}, false);

    expect(onCommitResize).not.toHaveBeenCalled();
  });
});
