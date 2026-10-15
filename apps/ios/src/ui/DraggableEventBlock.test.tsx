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
      for (const name of ['onBegin', 'onEnd', 'onFinalize', 'onStart', 'onUpdate']) {
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

/** Builds a 56-pt block once and hands back its pans and the commits it makes. */
const block = (edge: ReturnType<typeof edgeScroll> = edgeScroll()) => {
  pans.clear();
  reactions.length = 0;
  const onCommitMove = vi.fn((_deltaMinutes: number) => Promise.resolve());
  const onCommitResize = vi.fn((_deltaMinutes: number) => Promise.resolve());
  DraggableEventBlock({
    color: '#3366ff',
    compact: true,
    edgeScroll: edge as never,
    event: { recurrence: null } as unknown as EventRecord,
    height: 56,
    left: 0,
    onCommitMove,
    onCommitResize,
    onPress: () => {},
    readOnly: false,
    secondaryZones: [],
    timeZone: 'UTC',
    top: 0,
    width: '100%',
  });
  return { onCommitMove, onCommitResize, pans: [...pans.values()] };
};

/**
 * A touch at `y` in the block, held until the pan starts (at `startY`: a
 * held finger may drift a little first), dragged half an hour down and let
 * go (or cancelled).
 */
const drag = (pan: PanMock, y: number, options: { startY?: number; success?: boolean } = {}) => {
  const success = options.success ?? true;
  pan.handlers['onBegin']!({ y });
  pan.handlers['onStart']!({ absoluteY: 300, y: options.startY ?? y });
  pan.handlers['onUpdate']!({ absoluteY: 328, translationY: 28 });
  pan.handlers['onEnd']!({ translationY: 28 }, success);
  pan.handlers['onFinalize']!({}, success);
};

describe('DraggableEventBlock', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  // Two pans (the bottom edge's own and the block's, waiting on it) both
  // started on a hold on the edge; when the block's started first, it never
  // finalized and the block took no drag again.
  it('drags with one pan, so a hold on the bottom edge has nothing to race', () => {
    expect(block().pans).toHaveLength(1);
  });

  it('resizes from a hold on the bottom edge', () => {
    const {
      onCommitMove,
      onCommitResize,
      pans: [pan],
    } = block();
    drag(pan!, 50);
    expect(onCommitResize).toHaveBeenCalledWith(30);
    expect(onCommitMove).not.toHaveBeenCalled();
  });

  it('moves from a hold above the bottom edge', () => {
    const {
      onCommitMove,
      onCommitResize,
      pans: [pan],
    } = block();
    drag(pan!, 20);
    expect(onCommitMove).toHaveBeenCalledWith(30);
    expect(onCommitResize).not.toHaveBeenCalled();
  });

  // The touch-down picks the drag, as a handle's hit test did: a finger
  // drifting a few points during the hold must not swap move and resize.
  it('picks the drag where the finger touched down, not where the hold ended', () => {
    const {
      onCommitMove,
      onCommitResize,
      pans: [pan],
    } = block();
    drag(pan!, 35, { startY: 40 });
    expect(onCommitMove).toHaveBeenCalledWith(30);
    expect(onCommitResize).not.toHaveBeenCalled();
  });

  it('commits nothing for a cancelled drag, and takes the next one', () => {
    const edge = edgeScroll();
    const {
      onCommitResize,
      pans: [pan],
    } = block(edge);
    drag(pan!, 50, { success: false });
    expect(onCommitResize).not.toHaveBeenCalled();
    drag(pan!, 50);
    expect(onCommitResize).toHaveBeenCalledWith(30);
    // Each drag ended the edge scroll it started.
    expect(edge.begin).toHaveBeenCalledTimes(2);
    expect(edge.end).toHaveBeenCalledTimes(2);
  });

  it("moves by the finger's travel plus the grid the edge scroll moved under it", () => {
    const edge = edgeScroll();
    const {
      onCommitMove,
      pans: [pan],
    } = block(edge);
    const handlers = pan!.handlers;

    handlers['onBegin']!({ y: 20 });
    handlers['onStart']!({ absoluteY: 300, y: 20 });
    expect(edge.begin).toHaveBeenCalledOnce();
    handlers['onUpdate']!({ absoluteY: 728, translationY: 28 });
    expect(edge.follow).toHaveBeenLastCalledWith(728);
    // Two hours scrolled while the finger held still at the bottom edge.
    edge.scrollY.value += 112;
    for (const react of reactions) {
      react(1, 0);
    }
    handlers['onEnd']!({ translationY: 28 }, true);
    handlers['onFinalize']!({}, true);

    expect(onCommitMove).toHaveBeenCalledWith(150);
    expect(edge.end).toHaveBeenCalledOnce();
  });

  it('leaves the edge scroll alone when a touch never became a drag', () => {
    const edge = edgeScroll();
    const {
      pans: [pan],
    } = block(edge);
    pan!.handlers['onBegin']!({ y: 20 });
    pan!.handlers['onFinalize']!({}, false);
    expect(edge.begin).not.toHaveBeenCalled();
    expect(edge.end).not.toHaveBeenCalled();
  });
});
