import {
  DROPPED_NOTICE_TEXT,
  firstToTell,
  type MutationNotice,
  mutationNoticeText,
  useBroadcastNotice,
  useConflictAnnouncement,
  useGuardedMutations,
  useMutationNotice,
  usePendingOps,
  useTimeZones,
} from '@calendar/app-state';
import { describeConflict, isParkedOp } from '@calendar/core';
import { DROPPED_NOTICE_KEY } from '@calendar/db/keys';
import { createContext, type ReactNode, useContext, useEffect } from 'react';
import {
  AccessibilityInfo,
  Pressable,
  StyleSheet,
  Text,
  useWindowDimensions,
  View,
} from 'react-native';
import { subscribeInvalidations } from '../backend.ts';
import { askConflict } from './conflictAlert.ts';
import { type ThemeColors, useStyles } from './theme.ts';

/** The space between two notices, and between the stack and the edge it stands on. */
export const NOTICE_GAP = 8;

/**
 * VoiceOver reads `text` once it has finished what it is saying — it never
 * cuts a sentence off. A toast is gone in six seconds and never takes
 * focus, so without this a VoiceOver user would not learn it was there.
 */
export const announce = (text: string): void =>
  AccessibilityInfo.announceForAccessibilityWithOptions(text, { queue: true });

const InStack = createContext(false);

/**
 * Notices in one column that grows up from where it is mounted, its
 * children top to bottom. The calendar puts a failed write on top, a
 * change Google discarded under it and the conflict banner at the foot —
 * the desktop's order: the banner stays put while toasts come and go above
 * it, so it never moves under a finger.
 *
 * Mount it as a flow child at the edge the notices should stand on: last
 * in a tab screen's SafeAreaView, whose content ends at the tab bar's top
 * edge, or right above a screen's own controls at the bottom (the Tasks
 * tab's add field). It takes no room. `offset` lifts the column further:
 * over the floating "+" below iOS 26, over the home indicator in a modal.
 * A notice mounted on its own anchors itself the same way, so a screen
 * that shows one kind needs no stack.
 *
 * The anchor reaches a window's height up from that edge — its negative
 * margin cancels the height — and lets touches through, so the column
 * lies inside it. Under a zero-height anchor the notices were drawn but
 * missing from the accessibility tree (Maestro's hierarchy had none of
 * them): VoiceOver could not have reached them.
 */
export function NoticeStack({
  children,
  offset = NOTICE_GAP,
}: {
  children: ReactNode;
  offset?: number;
}) {
  const styles = useStyles(makeStyles);
  const { height } = useWindowDimensions();
  return (
    <View pointerEvents="box-none" style={[styles.anchor, { height, marginTop: -height }]}>
      <View pointerEvents="box-none" style={[styles.stack, { bottom: offset }]}>
        <InStack.Provider value>{children}</InStack.Provider>
      </View>
    </View>
  );
}

/** A notice inside a stack is one of its rows; one mounted alone anchors itself. */
function Placed({ children }: { children: ReactNode }) {
  return useContext(InStack) ? children : <NoticeStack>{children}</NoticeStack>;
}

const spoken = (notice: MutationNotice): string =>
  notice.detail ? `${mutationNoticeText(notice)} ${notice.detail}` : mutationNoticeText(notice);

/**
 * A failed fire-and-forget write (mutationGuard), or a drop the UI
 * refused; mirrors the desktop's. Every screen that can fail a write
 * mounts one (hidden tabs stay mounted), so a publish is spoken by
 * whichever toast gets it first, and only once.
 */
export function MutationNoticeToast() {
  const styles = useStyles(makeStyles);
  const shown = useMutationNotice();
  useEffect(() => {
    if (shown && firstToTell('mutation', shown.id)) {
      announce(spoken(shown.value));
    }
  }, [shown]);
  if (!shown) {
    return null;
  }
  return (
    <Placed>
      <View
        accessibilityLabel={spoken(shown.value)}
        accessible
        pointerEvents="none"
        style={[styles.toast, styles.error]}
        testID="mutation-toast"
      >
        <Text style={[styles.text, styles.onError]}>{mutationNoticeText(shown.value)}</Text>
        {shown.value.detail ? (
          <Text numberOfLines={2} style={[styles.detail, styles.onError]}>
            {shown.value.detail}
          </Text>
        ) : null}
      </View>
    </Placed>
  );
}

/** A queued change Google permanently rejected (4xx) was discarded. Parity with the desktop. */
export function DroppedToast() {
  const styles = useStyles(makeStyles);
  const shown = useBroadcastNotice(subscribeInvalidations, DROPPED_NOTICE_KEY);
  useEffect(() => {
    if (shown !== null && firstToTell('dropped', shown)) {
      announce(DROPPED_NOTICE_TEXT);
    }
  }, [shown]);
  if (shown === null) {
    return null;
  }
  return (
    <Placed>
      <View
        accessible
        pointerEvents="none"
        style={[styles.toast, styles.info]}
        testID="dropped-toast"
      >
        <Text style={[styles.text, styles.onInfo]}>{DROPPED_NOTICE_TEXT}</Text>
      </View>
    </Placed>
  );
}

/**
 * A queued change Google refused with a 412 (the event changed there
 * first). Stays until resolved: tapping it asks keep-mine / take-theirs.
 * Parity with the desktop ConflictBanner, which words it the same way.
 * VoiceOver hears each change that parks once — on mount for what is
 * already parked, then each new one — not every re-render; the calendar
 * mounts the banner once.
 */
export function ConflictBanner() {
  const styles = useStyles(makeStyles);
  const parked = usePendingOps().filter(isParkedOp);
  const { resolveConflict } = useGuardedMutations();
  const { primary: timeZone } = useTimeZones();
  useConflictAnnouncement(parked, timeZone, announce);
  const first = parked[0];
  if (!first) {
    return null;
  }
  return (
    <Placed>
      <Pressable
        accessibilityRole="button"
        onPress={() => askConflict(first, resolveConflict, timeZone)}
        style={[styles.toast, styles.conflict]}
        testID="conflict-banner"
      >
        <Text style={styles.conflictText}>
          {describeConflict(first, timeZone).headline} Tap to choose a version
          {parked.length > 1 ? ` (+${String(parked.length - 1)} more)` : ''}.
        </Text>
      </Pressable>
    </Placed>
  );
}

const makeStyles = (colors: ThemeColors) =>
  StyleSheet.create({
    anchor: {
      zIndex: 40,
    },
    conflict: {
      backgroundColor: colors.warning,
      borderColor: colors.warning,
      borderWidth: 1,
    },
    conflictText: {
      color: colors['on-warning'],
      fontSize: 13,
      textAlign: 'center',
    },
    detail: {
      fontSize: 11,
      marginTop: 2,
      textAlign: 'center',
    },
    error: {
      backgroundColor: colors.danger,
    },
    // Inverted against the canvas, like the desktop's.
    info: {
      backgroundColor: colors.text,
    },
    onError: {
      color: colors['on-danger'],
    },
    onInfo: {
      color: colors.canvas,
    },
    stack: {
      alignItems: 'center',
      gap: NOTICE_GAP,
      left: 16,
      position: 'absolute',
      right: 16,
    },
    text: {
      fontSize: 13,
      textAlign: 'center',
    },
    toast: {
      borderRadius: 10,
      elevation: 4,
      maxWidth: '100%',
      paddingHorizontal: 16,
      paddingVertical: 8,
      shadowColor: '#000000',
      shadowOffset: { height: 2, width: 0 },
      shadowOpacity: 0.25,
      shadowRadius: 6,
    },
  });
