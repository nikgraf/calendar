import type { useThreadEditor } from '@calendar/app-state';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { BOX_FONT_SCALE, type ThemeColors, useStyles } from '../theme.ts';

/**
 * The pager over several drafts (a share's events), under the editor's
 * header in either view, left out while there is one: the previous and
 * next draft around the focused one's place among them, then Remove and
 * "Add all"; under them, why "Add all" stopped. Off while an older step
 * is on show. The same test ids as the desktop's panel.
 */
export function DraftPager({ editor }: { readonly editor: ReturnType<typeof useThreadEditor> }) {
  const styles = useStyles(makeStyles);
  const { addAll, batchError, canAddAll, drafts, focused, settled, switchFocus, thread, write } =
    editor;
  if (drafts.length < 2 && !batchError) {
    return null;
  }
  return (
    <View style={styles.section}>
      {drafts.length > 1 ? (
        <View style={styles.pager} testID="draft-pager">
          <View style={styles.pagerSide}>
            <Pressable
              accessibilityLabel="Previous draft"
              accessibilityRole="button"
              disabled={focused === 0 || !settled}
              hitSlop={8}
              onPress={() => switchFocus(focused - 1)}
              style={(focused === 0 || !settled) && styles.disabled}
              testID="draft-prev"
            >
              <Text style={styles.arrow}>‹</Text>
            </Pressable>
            <Text style={styles.position} testID="draft-position">
              {focused + 1} of {drafts.length}
            </Text>
            <Pressable
              accessibilityLabel="Next draft"
              accessibilityRole="button"
              disabled={focused >= drafts.length - 1 || !settled}
              hitSlop={8}
              onPress={() => switchFocus(focused + 1)}
              style={(focused >= drafts.length - 1 || !settled) && styles.disabled}
              testID="draft-next"
            >
              <Text style={styles.arrow}>›</Text>
            </Pressable>
          </View>
          <View style={styles.pagerSide}>
            <Pressable
              accessibilityRole="button"
              disabled={!settled}
              hitSlop={8}
              onPress={() => thread.remove(focused)}
              testID="draft-remove"
            >
              <Text maxFontSizeMultiplier={BOX_FONT_SCALE} style={styles.secondary}>
                Remove
              </Text>
            </Pressable>
            {canAddAll ? (
              <Pressable
                accessibilityRole="button"
                accessibilityState={{ busy: write.busy, disabled: !settled }}
                disabled={!settled}
                onPress={() => void addAll()}
                style={[styles.addAll, !settled && styles.disabled]}
                testID="draft-add-all"
              >
                <Text maxFontSizeMultiplier={BOX_FONT_SCALE} style={styles.addAllLabel}>
                  Add all {drafts.length}
                </Text>
              </Pressable>
            ) : null}
          </View>
        </View>
      ) : null}
      {batchError ? (
        <Text selectable style={styles.error} testID="draft-batch-error">
          {batchError}
        </Text>
      ) : null}
    </View>
  );
}

const makeStyles = (colors: ThemeColors) =>
  StyleSheet.create({
    addAll: {
      backgroundColor: colors.primary,
      borderRadius: 8,
      paddingHorizontal: 12,
      paddingVertical: 4,
    },
    addAllLabel: {
      color: colors['on-primary'],
      fontSize: 14,
      fontWeight: '600',
    },
    arrow: {
      color: colors.primary,
      fontSize: 22,
      lineHeight: 24,
      paddingHorizontal: 6,
    },
    disabled: {
      opacity: 0.35,
    },
    error: {
      color: colors.danger,
      fontSize: 13,
    },
    pager: {
      alignItems: 'center',
      flexDirection: 'row',
      justifyContent: 'space-between',
    },
    pagerSide: {
      alignItems: 'center',
      flexDirection: 'row',
      gap: 10,
    },
    position: {
      color: colors['text-secondary'],
      fontSize: 13,
    },
    secondary: {
      color: colors['text-secondary'],
      fontSize: 15,
    },
    section: {
      gap: 8,
      paddingBottom: 12,
      paddingHorizontal: 16,
    },
  });
