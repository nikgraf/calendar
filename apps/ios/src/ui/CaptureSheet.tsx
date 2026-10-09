import { describeCaptureRow, type CaptureRow } from '@calendar/app-state';
import type { ReactNode } from 'react';
import { Modal, Pressable, SafeAreaView, ScrollView, StyleSheet, Text, View } from 'react-native';
import { BOX_FONT_SCALE, type ThemeColors, useStyles } from './theme.ts';

/**
 * The review list for a capture: every event found in a shared screenshot
 * or text, each a row that opens the normal edit sheet prefilled. Nothing
 * is written from here — a row counts as added only once its editor saved.
 * The edit sheet is rendered as a child (`children`) so it presents on top
 * of this one: two sibling Modals never show together on iOS.
 */
export function CaptureSheet({
  children,
  onClose,
  onOpenRow,
  rows,
  truncated,
}: {
  children?: ReactNode;
  onClose: () => void;
  onOpenRow: (row: CaptureRow) => void;
  rows: ReadonlyArray<CaptureRow>;
  truncated: boolean;
}) {
  const styles = useStyles(makeStyles);
  const allAdded = rows.every((row) => row.status === 'added');
  return (
    <Modal animationType="slide" onRequestClose={onClose} presentationStyle="pageSheet" visible>
      <SafeAreaView style={styles.container} testID="capture-sheet">
        <View style={styles.header}>
          <Text maxFontSizeMultiplier={BOX_FONT_SCALE} style={styles.title}>
            {rows.length} {rows.length === 1 ? 'event' : 'events'} found
          </Text>
          <Pressable accessibilityRole="button" onPress={onClose} testID="capture-close">
            <Text maxFontSizeMultiplier={BOX_FONT_SCALE} style={styles.close}>
              {allAdded ? 'Done' : 'Close'}
            </Text>
          </Pressable>
        </View>
        <Text style={styles.hint}>Open one to review it before it is added.</Text>
        <ScrollView contentContainerStyle={styles.list}>
          {rows.map((row, index) => (
            <Pressable
              accessibilityRole="button"
              accessibilityState={{ disabled: row.status === 'added' }}
              disabled={row.status === 'added'}
              key={row.id}
              onPress={() => onOpenRow(row)}
              style={[styles.row, row.status === 'added' && styles.rowAdded]}
              testID={`capture-row-${index}`}
            >
              <View style={styles.rowText}>
                <Text numberOfLines={1} style={styles.rowTitle}>
                  {row.prefill.title}
                </Text>
                <Text numberOfLines={1} style={styles.rowMeta}>
                  {describeCaptureRow(row)}
                </Text>
              </View>
              <Text style={row.status === 'added' ? styles.added : styles.open}>
                {row.status === 'added' ? 'Added' : 'Open'}
              </Text>
            </Pressable>
          ))}
          {truncated ? (
            <Text style={styles.note}>
              The text was long, so only its beginning was read — later events may be missing.
            </Text>
          ) : null}
        </ScrollView>
        {children}
      </SafeAreaView>
    </Modal>
  );
}

const makeStyles = (colors: ThemeColors) =>
  StyleSheet.create({
    added: {
      color: colors['text-secondary'],
      fontSize: 13,
    },
    close: {
      color: colors.primary,
      fontSize: 16,
      fontWeight: '600',
    },
    container: {
      backgroundColor: colors.canvas,
      flex: 1,
    },
    header: {
      alignItems: 'center',
      flexDirection: 'row',
      justifyContent: 'space-between',
      paddingHorizontal: 16,
      paddingVertical: 12,
    },
    hint: {
      color: colors['text-secondary'],
      fontSize: 13,
      paddingBottom: 8,
      paddingHorizontal: 16,
    },
    list: {
      gap: 8,
      paddingBottom: 32,
      paddingHorizontal: 16,
    },
    note: {
      color: colors['text-secondary'],
      fontSize: 12,
      paddingTop: 8,
    },
    open: {
      color: colors.primary,
      fontSize: 13,
      fontWeight: '600',
    },
    row: {
      alignItems: 'center',
      backgroundColor: colors.surface,
      borderColor: colors.border,
      borderRadius: 10,
      borderWidth: 1,
      flexDirection: 'row',
      gap: 12,
      paddingHorizontal: 12,
      paddingVertical: 10,
    },
    rowAdded: {
      opacity: 0.6,
    },
    rowMeta: {
      color: colors['text-secondary'],
      fontSize: 12,
      marginTop: 2,
    },
    rowText: {
      flex: 1,
    },
    rowTitle: {
      color: colors.text,
      fontSize: 15,
      fontWeight: '600',
    },
    title: {
      color: colors.text,
      fontSize: 17,
      fontWeight: '600',
    },
  });
