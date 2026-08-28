import { type MutationNotice, subscribeMutationNotices } from '@calendar/app-state';
import { CONFLICT_NOTICE_KEY } from '@calendar/db/keys';
import { useEffect, useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { subscribeInvalidations } from '../backend.ts';

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
 * Transient banner for 412 server-wins: the local edit was discarded.
 * Parity with the desktop ConflictToast — without it, a conflict on
 * iPhone was silent data loss.
 */
export function ConflictToast() {
  const [visible, setVisible] = useState(false);
  useEffect(
    () =>
      subscribeInvalidations((keys) => {
        if (keys.includes(CONFLICT_NOTICE_KEY)) {
          setVisible(true);
        }
      }),
    [],
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
      <Text style={styles.text}>An edit was overridden by a newer version from Google.</Text>
    </View>
  );
}

const styles = StyleSheet.create({
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
