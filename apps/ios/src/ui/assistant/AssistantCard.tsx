import {
  type CardLine,
  cardLines,
  type Draft,
  type DraftKeeps,
  type FieldChange,
} from '@calendar/app-state';
import { SymbolView, type SymbolViewProps } from 'expo-symbols';
import type { ReactNode } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { BOX_FONT_SCALE, type ThemeColors, useStyles, useTheme } from '../theme.ts';

const ICONS: Partial<Record<CardLine['field'], SymbolViewProps['name']>> = {
  alert: 'bell',
  guests: 'person.2',
  location: 'mappin.and.ellipse',
  notes: 'text.alignleft',
  priority: 'exclamationmark.circle',
  reminders: 'bell',
  repeat: 'repeat',
  url: 'link',
};

/**
 * A line's value: marked when the step changed it, with what it read
 * before struck through after it. Guests are listed one by one, so only
 * the ones the step invited are marked.
 */
function Value({ line }: { readonly line: CardLine }) {
  const styles = useStyles(makeStyles);
  // The id is on the text itself: a flow reads what the line says by it.
  const testID = `assistant-card-${line.field}`;
  if (line.names && line.added) {
    const { added, names } = line;
    return (
      <Text style={styles.value} testID={testID}>
        {names.map((name, index) => (
          <Text key={name}>
            {index > 0 ? ', ' : ''}
            <Text style={added.includes(name) ? styles.mark : null}>
              {added.includes(name) ? ` ${name} ` : name}
            </Text>
          </Text>
        ))}
      </Text>
    );
  }
  return (
    <Text style={styles.value} testID={testID}>
      <Text style={line.changed ? styles.mark : null}>
        {line.changed ? ` ${line.text} ` : line.text}
      </Text>
      {line.was === undefined ? null : (
        <>
          {'  '}
          <Text style={styles.was}>{line.was}</Text>
        </>
      )}
    </Text>
  );
}

/**
 * An item as the assistant answers with it: where it goes, its title, the
 * day and the hours, then whatever else it holds (`cardLines`) — each
 * field the step changed marked in the `highlight` tint the form marks
 * its rows with, the old value struck through beside it. `label` names
 * the version; `footer` holds what can be done about it. The desktop's
 * card, with the same test ids.
 */
export function AssistantCard({
  changes,
  color,
  container,
  draft,
  footer,
  keeps,
  label,
}: {
  /** What the step the card is of did to the draft; empty marks nothing. */
  readonly changes: ReadonlyArray<FieldChange>;
  /** The calendar's or list's color, when it has one. */
  readonly color?: string | undefined;
  /** The calendar or list the item goes to, by name. */
  readonly container?: string | undefined;
  readonly draft: Draft;
  readonly footer?: ReactNode;
  /** What is saved where the draft goes (`DraftKeeps`): the card shows no time or guests that are not. */
  readonly keeps?: DraftKeeps | undefined;
  readonly label: string;
}) {
  const styles = useStyles(makeStyles);
  const { colors } = useTheme();
  const lines = cardLines(draft, changes, keeps);
  const when = lines.filter((line) => line.field === 'date' || line.field === 'time');
  const rest = lines.filter((line) => line.field !== 'date' && line.field !== 'time');
  const retitled = changes.some((change) => change.field === 'title');
  const title = draft.item.prefill.title || 'Untitled';
  return (
    <View style={styles.card} testID="assistant-card">
      <View style={styles.top}>
        <View style={styles.container}>
          {color ? <View style={[styles.dot, { backgroundColor: color }]} /> : null}
          <Text maxFontSizeMultiplier={BOX_FONT_SCALE} numberOfLines={1} style={styles.secondary}>
            {container ?? (draft.item.kind === 'task' ? 'To-do' : 'Event')}
          </Text>
        </View>
        <Text maxFontSizeMultiplier={BOX_FONT_SCALE} style={styles.label}>
          {label.toUpperCase()}
        </Text>
      </View>
      <Text style={styles.title} testID="assistant-card-title">
        <Text style={retitled ? styles.mark : null}>{retitled ? ` ${title} ` : title}</Text>
      </Text>
      <View style={styles.line}>
        <SymbolView
          name="clock"
          size={17}
          style={styles.icon}
          tintColor={colors['text-secondary']}
          weight="medium"
        />
        <View style={styles.when}>
          {when.map((line) => (
            <Value key={line.field} line={line} />
          ))}
        </View>
      </View>
      {rest.map((line) => (
        <View key={line.field} style={styles.line}>
          <SymbolView
            name={ICONS[line.field] ?? 'pencil'}
            size={17}
            style={styles.icon}
            tintColor={colors['text-secondary']}
            weight="medium"
          />
          <View style={styles.rest}>
            <Value line={line} />
          </View>
        </View>
      ))}
      {footer}
    </View>
  );
}

const makeStyles = (colors: ThemeColors) =>
  StyleSheet.create({
    card: {
      backgroundColor: colors.surface,
      borderRadius: 20,
      gap: 10,
      paddingBottom: 6,
      paddingHorizontal: 16,
      paddingTop: 14,
      shadowColor: '#000000',
      shadowOffset: { height: 2, width: 0 },
      shadowOpacity: 0.06,
      shadowRadius: 8,
    },
    container: {
      alignItems: 'center',
      flexDirection: 'row',
      flexShrink: 1,
      gap: 6,
    },
    dot: {
      borderRadius: 5,
      height: 10,
      width: 10,
    },
    icon: {
      height: 20,
      marginTop: 1,
      width: 20,
    },
    label: {
      color: colors['text-secondary'],
      fontSize: 12,
      fontWeight: '600',
      letterSpacing: 0.3,
    },
    line: {
      alignItems: 'flex-start',
      flexDirection: 'row',
      gap: 10,
    },
    /** What a step changed: the form's `highlight`, the words in the ink. */
    mark: {
      backgroundColor: colors.highlight,
      color: colors.text,
      fontWeight: '600',
    },
    rest: {
      flex: 1,
    },
    secondary: {
      color: colors['text-secondary'],
      flexShrink: 1,
      fontSize: 13,
    },
    title: {
      color: colors.text,
      fontSize: 20,
      fontWeight: '600',
      lineHeight: 25,
    },
    top: {
      alignItems: 'center',
      flexDirection: 'row',
      gap: 8,
      justifyContent: 'space-between',
    },
    value: {
      color: colors.text,
      fontSize: 16,
      lineHeight: 22,
    },
    was: {
      color: colors['text-secondary'],
      textDecorationLine: 'line-through',
    },
    when: {
      columnGap: 10,
      flex: 1,
      flexDirection: 'row',
      flexWrap: 'wrap',
      rowGap: 2,
    },
  });
