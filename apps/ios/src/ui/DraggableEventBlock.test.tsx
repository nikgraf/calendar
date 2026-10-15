import type { EventRecord } from '@calendar/core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vite-plus/test';

type Callback = (...args: Array<unknown>) => void;

interface PanMock {
  readonly handlers: Record<string, Callback>;
  waitsFor: PanMock | null;
}

/** Every `Gesture.Pan()` the last render built, by the builder it returned. */
const pans = vi.hoisted(() => new Map<unknown, PanMock>());
/** The last render's `useAnimatedReaction`s, to fire as the UI runtime would. */
const reactions = vi.hoisted(() => [] as Array<(value: unknown, previous: unknown) => void>);

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
  useAnimatedReaction: (_prepare: unknown, react: (value: unknown, previous: unknown) => void) => {
    reactions.push(react);
  },
  useAnimatedStyle: () => ({}),
  useSharedValue: <T,>(value: T) => ({ value }),
  withTiming: <T,>(value: T) => value,
}));
vi.mock('./theme.ts', () => ({
  BOX_FONT_SCALE: 1.35,
  useEventTint: () => ({ fill: '#ffffff', text: '#000000' }),
}));

const { DraggableEventBlock } = await import('./DraggableEventBlock.tsx');

/** The timeline's edge scroll as a block sees it: the grid's offset and the drag's calls. */
const edgeScroll = () => ({
  begin: vi.fn(),
  end: vi.fn(),
  follow: vi.fn(),
  scrollY: { value: 400 },
  ticks: { value: 0 },
});

/** Builds the block once and hands back its two pans' callbacks. */
const block = (
  onCommitResize: () => Promise<void>,
  options: {
    edge?: ReturnType<typeof edgeScroll>;
    onCommitMove?: (deltaMinutes: number) => Promise<void>;
  } = {},
) => {
  pans.clear();
  reactions.length = 0;
  DraggableEventBlock({
    color: '#3366ff',
    compact: true,
    edgeScroll: (options.edge ?? edgeScroll()) as never,
    event: { recurrence: null } as unknown as EventRecord,
    height: 56,
    left: 0,
    onCommitMove: options.onCommitMove ?? (() => Promise.resolve()),
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

    resize['onStart']!({ absoluteY: 300 });
    // The resize activating fails the move pan, which still finalizes.
    move['onFinalize']!({}, false);
    resize['onUpdate']!({ absoluteY: 328, translationY: 28 });
    resize['onEnd']!({ translationY: 28 }, true);
    resize['onFinalize']!({}, true);

    expect(onCommitResize).toHaveBeenCalledWith(30);
  });

  it('commits nothing for a cancelled resize', () => {
    const onCommitResize = vi.fn(() => Promise.resolve());
    const { resize } = block(onCommitResize);

    resize['onStart']!({ absoluteY: 300 });
    resize['onUpdate']!({ absoluteY: 328, translationY: 28 });
    resize['onEnd']!({ translationY: 28 }, false);
    resize['onFinalize']!({}, false);

    expect(onCommitResize).not.toHaveBeenCalled();
  });

  it("moves by the finger's travel plus the grid the edge scroll moved under it", () => {
    const onCommitMove = vi.fn(() => Promise.resolve());
    const edge = edgeScroll();
    const { move } = block(() => Promise.resolve(), { edge, onCommitMove });

    move['onStart']!({ absoluteY: 300 });
    expect(edge.begin).toHaveBeenCalledOnce();
    move['onUpdate']!({ absoluteY: 728, translationY: 28 });
    expect(edge.follow).toHaveBeenLastCalledWith(728);
    // Two hours scrolled while the finger held still at the bottom edge.
    edge.scrollY.value += 112;
    for (const react of reactions) {
      react(1, 0);
    }
    move['onEnd']!({ translationY: 28 }, true);
    move['onFinalize']!({}, true);

    expect(onCommitMove).toHaveBeenCalledWith(150);
    expect(edge.end).toHaveBeenCalledOnce();
  });

  it('leaves the edge scroll alone when its pan never owned the drag', () => {
    const edge = edgeScroll();
    const { move, resize } = block(() => Promise.resolve(), { edge });

    resize['onStart']!({ absoluteY: 300 });
    move['onFinalize']!({}, false);
    expect(edge.end).not.toHaveBeenCalled();
    resize['onFinalize']!({}, false);
    expect(edge.end).toHaveBeenCalledOnce();
  });
});
