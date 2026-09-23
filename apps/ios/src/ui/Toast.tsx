import {
  type MutationNotice,
  subscribeMutationNotices,
  useGuardedMutations,
  usePendingOps,
} from '@calendar/app-state';
import { isParkedOp } from '@calendar/core';
import { DROPPED_NOTICE_KEY } from '@calendar/db/keys';
import { useEffect, useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { subscribeInvalidations } from '../backend.ts';
import { askConflict } from './conflictAlert.ts';

/**
 * Transient banner for failed fire-and-forget mutations (mutationGuard).
 * Mirrors the desktop MutationNoticeToast in App.tsx.
 */
export function MutationNoticeToast() {
  const [notice, setNotice] = useState<MutationNotice | null>(null);
  useEffect(() => subscribeMutationNotices(setNotice), []);
  useEffect(() => {
    if (!notice) {
      return;
    }
    const timer = setTimeout(() => setNotice(null), 6000);
    return () => clearTimeout(timer);
  }, [notice]);

  if (!notice) {
    return null;
  }
  return (
    <View pointerEvents="none" style={[styles.toast, styles.error]}>
      <Text style={styles.text}>Couldn&rsquo;t {notice.action} — the change was not applied.</Text>
      {notice.detail ? (
        <Text numberOfLines={2} style={styles.detail}>
          {notice.detail}
        </Text>
      ) : null}
    </View>
  );
}

/**
 * Transient banner keyed on a broadcast invalidation. Parity with the
 * desktop NoticeToast.
 */
function NoticeToast({ message, noticeKey }: { message: string; noticeKey: string }) {
  const [visible, setVisible] = useState(false);
  useEffect(
    () =>
      subscribeInvalidations((keys) => {
        if (keys.includes(noticeKey)) {
          setVisible(true);
        }
      }),
    [noticeKey],
  );
  useEffect(() => {
    if (!visible) {
      return;
    }
    const timer = setTimeout(() => setVisible(false), 6000);
    return () => clearTimeout(timer);
  }, [visible]);

  if (!visible) {
    return null;
  }
  return (
    <View pointerEvents="none" style={[styles.toast, styles.info]}>
      <Text style={styles.text}>{message}</Text>
    </View>
  );
}

/**
 * A queued change Google refused with a 412 (the event changed there
 * first). Stays until resolved: tapping it asks keep-mine / take-theirs.
 * Parity with the desktop ConflictBanner.
 */
export function ConflictBanner() {
  const parked = usePendingOps().filter(isParkedOp);
  const { resolveConflict } = useGuardedMutations();
  const first = parked[0];
  if (!first) {
    return null;
  }
  const name = first.title || first.conflict.theirs?.title || 'An event';
  return (
    <Pressable
      accessibilityRole="button"
      onPress={() => askConflict(first, resolveConflict)}
      style={[styles.toast, styles.conflict]}
      testID="conflict-banner"
    >
      <Text style={styles.conflictText}>
        “{name}” changed on Google while your change waited. Tap to choose a version
        {parked.length > 1 ? ` (+${String(parked.length - 1)} more)` : ''}.
      </Text>
    </Pressable>
  );
}

/** A queued change Google permanently rejected (4xx) was discarded. */
export function DroppedToast() {
  return (
    <NoticeToast
      message="Google rejected a change and it was discarded."
      noticeKey={DROPPED_NOTICE_KEY}
    />
  );
}

const styles = StyleSheet.create({
  conflict: {
    backgroundColor: '#fffbeb',
    borderColor: '#fcd34d',
    borderWidth: 1,
  },
  conflictText: {
    color: '#78350f',
    fontSize: 13,
    textAlign: 'center',
  },
  detail: {
    color: '#ffffffcc',
    fontSize: 11,
    marginTop: 2,
    textAlign: 'center',
  },
  error: {
    backgroundColor: '#b91c1c',
  },
  info: {
    backgroundColor: '#171717',
  },
  text: {
    color: '#ffffff',
    fontSize: 13,
    textAlign: 'center',
  },
  toast: {
    alignSelf: 'center',
    borderRadius: 10,
    bottom: 24,
    elevation: 4,
    maxWidth: '90%',
    paddingHorizontal: 16,
    paddingVertical: 8,
    position: 'absolute',
    shadowColor: '#000000',
    shadowOffset: { height: 2, width: 0 },
    shadowOpacity: 0.25,
    shadowRadius: 6,
    zIndex: 40,
  },
});
