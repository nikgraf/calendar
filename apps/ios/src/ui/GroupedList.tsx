import { EXPERIMENTAL_COPY } from '@calendar/core';
import { Host, Switch } from '@expo/ui';
import { labelsHidden } from '@expo/ui/swift-ui/modifiers';
import { type Href, useRouter } from 'expo-router';
import { type SFSymbol, SymbolView, type SymbolViewProps } from 'expo-symbols';
import {
  Children,
  createContext,
  isValidElement,
  type ReactNode,
  useContext,
  useState,
} from 'react';
import {
  type AccessibilityActionEvent,
  type AccessibilityRole,
  type AccessibilityState,
  Image,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  type TextInputProps,
  View,
} from 'react-native';
import { Pressable as GesturePressable } from 'react-native-gesture-handler';
import ReanimatedSwipeable from 'react-native-gesture-handler/ReanimatedSwipeable';
import {
  actionText,
  BOX_FONT_SCALE,
  chipTextColor,
  groupedGround,
  type ThemeColors,
  useStyles,
  useTheme,
} from './theme.ts';

/**
 * The building blocks of the Settings pages and the editor's forms:
 * iOS's inset grouped list — sections of rows on a tinted ground, an
 * uppercase header above a section, explanations in its footer — drawn
 * on the brand tokens. Rows use the real controls (SwiftUI's toggle
 * through `@expo/ui`) and a separator that starts at the text, not under
 * the icon. The forms add rows that are a text field, a row of chips
 * under a label, and free content (`FieldRow`, `ChipsRow`, `RowSlot`).
 */

/**
 * An SF Symbol that only decorates. Hidden from accessibility: a symbol's
 * image carries its own label ("add", "Forward"), which a pressable row
 * would read out before its title — and which Maestro's text match sees.
 */
export function Glyph(props: SymbolViewProps) {
  return (
    <View accessibilityElementsHidden importantForAccessibility="no-hide-descendants">
      <SymbolView {...props} />
    </View>
  );
}

/**
 * Inside a swipeable row React Native's own Pressable never sees the tap —
 * the swipe's pan gesture takes the touch first — so rows and actions
 * there press through gesture-handler's twin (the same props).
 */
const SwipePressable = GesturePressable as unknown as typeof Pressable;

/** Whether a row is its section's first, which draws no separator above it. */
const FirstRowContext = createContext(true);

/**
 * One Settings page: a scroll view that runs to the screen edges (a
 * clipped control still counts as visible to Maestro) and lets the large
 * title collapse. `keyboardShouldPersistTaps`: a Modal a page opens (the
 * time-zone picker, the mirror editor) is its child in the React tree, so
 * without it the first tap on the Modal's rows only dismisses the keyboard.
 */
export function SettingsPage({ children, testID }: { children: ReactNode; testID: string }) {
  const styles = useStyles(makeStyles);
  return (
    <ScrollView
      automaticallyAdjustKeyboardInsets
      contentContainerStyle={styles.content}
      contentInsetAdjustmentBehavior="automatic"
      keyboardShouldPersistTaps="handled"
      style={styles.page}
      testID={testID}
    >
      {children}
    </ScrollView>
  );
}

/**
 * A section: optional header, its rows in one rounded card, optional
 * footer text. `tight`: the editor's forms, whose sections sit closer
 * than Settings' (more of them, few footers between).
 */
export function Section({
  children,
  footer,
  header,
  testID,
  tight = false,
}: {
  children?: ReactNode;
  footer?: ReactNode;
  header?: string;
  testID?: string;
  tight?: boolean;
}) {
  const styles = useStyles(makeStyles);
  const rows = Children.toArray(children);
  return (
    <View style={[styles.section, tight && styles.sectionTight]} testID={testID}>
      {header ? <Text style={styles.header}>{header}</Text> : null}
      {rows.length > 0 ? (
        <View style={styles.card}>
          <Rows first>{rows}</Rows>
        </View>
      ) : null}
      {typeof footer === 'string' ? <Footer>{footer}</Footer> : footer}
    </View>
  );
}

/**
 * Several rows from one component (a field with its suggestions under
 * it): each but the first draws its separator, and the first draws one
 * only when something in the card precedes the group. A Section sees the
 * component as one child, so this hands the card's position on.
 */
export function Rows({ children, first }: { children: ReactNode; first?: boolean }) {
  const inherited = useContext(FirstRowContext);
  const leads = first ?? inherited;
  return Children.toArray(children).map((row, index) => (
    <FirstRowContext.Provider
      key={isValidElement(row) && row.key !== null ? row.key : index}
      value={index === 0 && leads}
    >
      {row}
    </FirstRowContext.Provider>
  ));
}

/**
 * A row that is a text field — the editor's Title, Location, Notes and
 * URL: the field fills the row, so a tap anywhere in it lands in the
 * field, and a multiline one grows with its text. The ink is set: a
 * TextInput's defaults to black whatever the appearance.
 */
export function FieldRow({
  multiline = false,
  style,
  ...input
}: TextInputProps & { multiline?: boolean }) {
  const styles = useStyles(makeStyles);
  const { colors } = useTheme();
  const first = useContext(FirstRowContext);
  return (
    <View style={[styles.fieldRow, !first && styles.separator]}>
      <TextInput
        placeholderTextColor={colors['text-secondary']}
        {...input}
        multiline={multiline}
        style={[styles.field, multiline && styles.fieldMultiline, style]}
      />
    </View>
  );
}

/** Free content in a row's box, with the row's insets and separator (a field with chips, a finder). */
export function RowSlot({ children, testID }: { children: ReactNode; testID?: string }) {
  const styles = useStyles(makeStyles);
  const first = useContext(FirstRowContext);
  return (
    <View style={[styles.slot, !first && styles.separator]} testID={testID}>
      {children}
    </View>
  );
}

/**
 * A row of chips, under a label when the card's header does not name
 * them — the editor's repeat, priority, alert and notification choices.
 */
export function ChipsRow({
  children,
  label,
  testID,
}: {
  children: ReactNode;
  label?: string;
  testID?: string;
}) {
  const styles = useStyles(makeStyles);
  const first = useContext(FirstRowContext);
  return (
    <View style={[styles.slot, !first && styles.separator]} testID={testID}>
      {label ? <Text style={styles.title}>{label}</Text> : null}
      <View style={styles.chips}>{children}</View>
    </View>
  );
}

/** A caption inside a card over the rows it groups (an account's calendars). */
export function CardCaption({ children }: { children: string }) {
  const styles = useStyles(makeStyles);
  const first = useContext(FirstRowContext);
  return <Text style={[styles.caption, !first && styles.separator]}>{children}</Text>;
}

/** A calendar's or list's color as a small dot, leading its row. */
export function ColorDot({ color }: { color: string }) {
  const styles = useStyles(makeStyles);
  return <View style={[styles.dot, { backgroundColor: color }]} />;
}

/**
 * One row of a card a virtualized list draws, where a Section cannot wrap
 * the rows (it would render them all): the first row takes the card's
 * rounded top and draws no separator, the last its rounded bottom.
 */
export function CardRow({
  children,
  first,
  last,
}: {
  children: ReactNode;
  first: boolean;
  last: boolean;
}) {
  const styles = useStyles(makeStyles);
  return (
    <View style={[styles.cardRow, first && styles.cardTop, last && styles.cardBottom]}>
      <FirstRowContext.Provider value={first}>{children}</FirstRowContext.Provider>
    </View>
  );
}

/** A paragraph under a section; `tone="danger"` for a failure the page reports. */
export function Footer({
  children,
  selectable = false,
  testID,
  tone = 'secondary',
}: {
  children: ReactNode;
  /** Long-press to copy (an error's text). */
  selectable?: boolean;
  testID?: string;
  tone?: 'danger' | 'secondary';
}) {
  const styles = useStyles(makeStyles);
  return (
    <Text
      selectable={selectable}
      style={[styles.footer, tone === 'danger' && styles.danger]}
      testID={testID}
    >
      {children}
    </Text>
  );
}

/** A page's opening card: a large icon, the page's name and what it is for. */
export function PageHero({
  children,
  icon,
  subtitle,
  title,
}: {
  children?: ReactNode;
  icon?: ReactNode;
  subtitle?: string;
  title: string;
}) {
  const styles = useStyles(makeStyles);
  return (
    <View style={styles.hero}>
      {icon}
      <Text accessibilityRole="header" style={styles.heroTitle}>
        {title}
      </Text>
      {subtitle ? <Text style={styles.heroSubtitle}>{subtitle}</Text> : null}
      {children}
    </View>
  );
}

/**
 * A small grey capsule that names a state ("Experimental", a time zone's
 * "Primary"); the desktop draws the same pill.
 */
export function Tag({ label, testID }: { label: string; testID?: string }) {
  const styles = useStyles(makeStyles);
  return (
    <View style={styles.tag} testID={testID}>
      <Text style={styles.tagLabel}>{label}</Text>
    </View>
  );
}

/**
 * What "Experimental" on the Settings root means, inside the PageHero of
 * each page listed under it: the capsule, then one line.
 */
export function ExperimentalNote() {
  const styles = useStyles(makeStyles);
  return (
    <View style={styles.experimental} testID="experimental-note">
      <Tag label={EXPERIMENTAL_COPY.label} />
      <Text style={styles.experimentalNote}>{EXPERIMENTAL_COPY.note}</Text>
    </View>
  );
}

type RowTone = 'destructive' | 'normal' | 'tint';

interface RowProps {
  accessibilityLabel?: string;
  accessibilityRole?: AccessibilityRole;
  accessibilityState?: AccessibilityState;
  /** Trailing element after the value (chevron, checkmark, switch, button). */
  accessory?: ReactNode;
  /** Centres the title (a destructive button row). */
  centered?: boolean;
  disabled?: boolean;
  /** Inside a SwipeRow: presses go through gesture-handler. */
  inSwipe?: boolean;
  leading?: ReactNode;
  onPress?: () => void;
  subtitle?: string;
  subtitleTestID?: string;
  subtitleTone?: 'secondary' | 'warning';
  /** A swipe action's VoiceOver twin (see SwipeRow). */
  swipeAction?: { label: string; run: () => void };
  testID?: string;
  title: string;
  tone?: RowTone;
  value?: string;
  valueTestID?: string;
}

/**
 * The row every other row is made of. Pressable only with `onPress`: a
 * pressable row is one accessibility element (its texts read as one), so
 * rows holding their own controls (a switch, a button) stay plain views
 * whose controls VoiceOver and Maestro reach one by one.
 */
export function Row({
  accessibilityLabel,
  accessibilityRole,
  accessibilityState,
  accessory,
  centered = false,
  disabled = false,
  inSwipe = false,
  leading,
  onPress,
  subtitle,
  subtitleTestID,
  subtitleTone = 'secondary',
  swipeAction,
  testID,
  title,
  tone = 'normal',
  value,
  valueTestID,
}: RowProps) {
  const styles = useStyles(makeStyles);
  const first = useContext(FirstRowContext);
  const body = (
    <>
      {leading ? <View style={styles.leading}>{leading}</View> : null}
      <View style={[styles.body, !first && styles.separator]}>
        <View style={styles.text}>
          <Text
            style={[
              styles.title,
              tone === 'tint' && styles.tint,
              tone === 'destructive' && styles.danger,
              centered && styles.centered,
            ]}
          >
            {title}
          </Text>
          {subtitle ? (
            <Text
              style={[styles.subtitle, subtitleTone === 'warning' && styles.warning]}
              testID={subtitleTestID}
            >
              {subtitle}
            </Text>
          ) : null}
        </View>
        {value === undefined ? null : (
          <Text numberOfLines={1} style={styles.value} testID={valueTestID}>
            {value}
          </Text>
        )}
        {accessory}
      </View>
    </>
  );
  const actions = swipeAction ? [{ label: swipeAction.label, name: 'swipeAction' }] : undefined;
  const onAction = swipeAction
    ? (event: AccessibilityActionEvent) => {
        if (event.nativeEvent.actionName === 'swipeAction') {
          swipeAction.run();
        }
      }
    : undefined;
  if (!onPress) {
    return (
      <View
        accessibilityActions={actions}
        accessible={swipeAction ? true : undefined}
        onAccessibilityAction={onAction}
        style={[styles.row, disabled && styles.disabled]}
        testID={testID}
      >
        {body}
      </View>
    );
  }
  const Press = inSwipe ? SwipePressable : Pressable;
  return (
    <Press
      accessibilityActions={actions}
      accessibilityLabel={accessibilityLabel}
      accessibilityRole={accessibilityRole ?? 'button'}
      accessibilityState={{ disabled, ...accessibilityState }}
      disabled={disabled}
      onAccessibilityAction={onAction}
      onPress={onPress}
      style={({ pressed }) => [styles.row, pressed && styles.pressed, disabled && styles.disabled]}
      testID={testID}
    >
      {body}
    </Press>
  );
}

/** The disclosure chevron of a row that pushes a page. */
export function Chevron() {
  const { colors } = useTheme();
  return (
    <Glyph name="chevron.right" size={13} tintColor={colors['border-strong']} weight="semibold" />
  );
}

/** A row that pushes another Settings page. */
export function NavRow({
  badge,
  href,
  ...row
}: Omit<RowProps, 'accessory' | 'onPress'> & { badge?: number; href: Href }) {
  const router = useRouter();
  const styles = useStyles(makeStyles);
  return (
    <Row
      {...row}
      accessory={
        <>
          {badge === undefined ? null : (
            <View style={styles.badge}>
              <Text style={styles.badgeLabel}>{badge}</Text>
            </View>
          )}
          <Chevron />
        </>
      }
      onPress={() => router.push(href)}
    />
  );
}

/**
 * A row with a switch; the row itself is not a button, the switch is.
 * SwiftUI's toggle through `@expo/ui`, not React Native's `Switch`: on
 * iOS 26 the system switch grew to 63 × 28 pt while React Native still
 * lays it out at 51 × 31, so it drew 14 pt above and 22 pt left of its
 * row's centre.
 */
export function SwitchRow({
  disabled = false,
  onValueChange,
  switchTestID,
  title,
  value,
  ...row
}: Omit<RowProps, 'accessory' | 'onPress' | 'value' | 'valueTestID'> & {
  onValueChange: (value: boolean) => void;
  switchTestID?: string;
  value: boolean;
}) {
  return (
    <Row
      {...row}
      accessory={
        <Host matchContents>
          <Switch
            disabled={disabled}
            label={title}
            modifiers={[labelsHidden()]}
            onValueChange={onValueChange}
            testID={switchTestID}
            value={value}
          />
        </Host>
      }
      disabled={disabled}
      title={title}
    />
  );
}

/** The trailing checkmark of a chosen row (an empty slot of the same width when not chosen). */
export function Checkmark({ checked }: { checked: boolean }) {
  const { colors } = useTheme();
  const styles = useStyles(makeStyles);
  return checked ? (
    <Glyph name="checkmark" size={17} tintColor={colors.primary} weight="semibold" />
  ) : (
    <View style={styles.checkSpace} />
  );
}

/** One choice of a list: a radio (one of many) or a checkbox, marked by a trailing checkmark. */
export function CheckRow({
  checked,
  kind = 'radio',
  ...row
}: Omit<RowProps, 'accessibilityRole' | 'accessibilityState' | 'accessory'> & {
  checked: boolean;
  kind?: 'checkbox' | 'radio';
}) {
  return (
    <Row
      {...row}
      accessibilityRole={kind}
      accessibilityState={kind === 'radio' ? { selected: checked } : { checked }}
      accessory={<Checkmark checked={checked} />}
    />
  );
}

/** A button as a row: tinted text, or red and centred for a destructive action. */
export function ActionRow({
  tone = 'tint',
  ...row
}: Omit<RowProps, 'accessory' | 'centered' | 'onPress' | 'tone'> & {
  onPress: () => void;
  tone?: 'destructive' | 'tint';
}) {
  return <Row {...row} centered={tone === 'destructive' && !row.leading} tone={tone} />;
}

/**
 * A row with one action revealed by swiping left (Remove, Reset, Discard),
 * the way iOS lists delete. The swipe tracks the finger and snaps open or
 * shut; VoiceOver offers the same action on the row.
 */
export function SwipeRow({
  action,
  actionLabel,
  actionTestID,
  ...row
}: Omit<RowProps, 'inSwipe' | 'swipeAction'> & {
  action: () => void;
  actionLabel: string;
  actionTestID: string;
}) {
  const styles = useStyles(makeStyles);
  return (
    <ReanimatedSwipeable
      childrenContainerStyle={styles.swipeContent}
      overshootRight={false}
      renderRightActions={(_progress, _translation, swipeable) => (
        <SwipePressable
          accessibilityRole="button"
          onPress={() => {
            swipeable.close();
            action();
          }}
          style={styles.swipeAction}
          testID={actionTestID}
        >
          <Text style={styles.swipeActionLabel}>{actionLabel}</Text>
        </SwipePressable>
      )}
      rightThreshold={40}
    >
      <Row {...row} inSwipe swipeAction={{ label: actionLabel, run: action }} />
    </ReanimatedSwipeable>
  );
}

/** One field of an expanded row: what it was (struck through) and what it becomes. */
export interface DetailLine {
  readonly after: string | null;
  readonly before: string | null;
  readonly label: string;
}

/**
 * The lines under an expanded row, indented to its text: a field's name,
 * its value before (struck through, secondary) and after. With no lines,
 * `emptyText` says why.
 */
export function DetailLines({
  emptyText,
  lines,
  testID,
}: {
  emptyText: string;
  lines: ReadonlyArray<DetailLine>;
  testID?: string;
}) {
  const styles = useStyles(makeStyles);
  return (
    <View style={styles.detail} testID={testID}>
      {lines.length === 0 ? (
        <Text style={styles.detailEmpty}>{emptyText}</Text>
      ) : (
        lines.map((line, index) => (
          <View key={`${line.label}-${String(index)}`} style={styles.detailLine}>
            <Text style={styles.detailLabel}>{line.label}</Text>
            {line.before === null ? null : (
              <Text style={[styles.detailValue, styles.detailBefore]}>{line.before}</Text>
            )}
            {line.after === null ? null : <Text style={styles.detailValue}>{line.after}</Text>}
          </View>
        ))
      )}
    </View>
  );
}

/** The rounded square with a symbol that leads a top-level row (30 pt), or a page's hero (56 pt). */
export function IconTile({
  color,
  foreground,
  name,
  size = 30,
}: {
  color: string;
  /** The symbol's color; the canvas by default (white in light, near-black in dark). */
  foreground?: string;
  name: SFSymbol;
  size?: number;
}) {
  const { colors } = useTheme();
  const styles = useStyles(makeStyles);
  return (
    <View
      style={[
        styles.tile,
        { backgroundColor: color, borderRadius: size * 0.27, height: size, width: size },
      ]}
    >
      <Glyph
        name={name}
        size={Math.round(size * 0.57)}
        tintColor={foreground ?? colors.canvas}
        weight="medium"
      />
    </View>
  );
}

/** A plain symbol in the leading column (no tile), e.g. a warning triangle or a "+". */
export function LeadingSymbol({ color, name }: { color: string; name: SFSymbol }) {
  const styles = useStyles(makeStyles);
  return (
    <View style={styles.tileSpace}>
      <Glyph name={name} size={20} tintColor={color} weight="medium" />
    </View>
  );
}

/** An empty leading column, so a row's text lines up with its iconed neighbours. */
export function LeadingSpace() {
  const styles = useStyles(makeStyles);
  return <View style={styles.tileSpace} />;
}

/**
 * A person's or account's initial in a tinted circle, under their photo
 * when there is one (`uri`, a Google account's picture): the initial
 * shows while the photo loads and stays when it cannot load (offline).
 */
export function Avatar({
  background,
  foreground,
  label,
  size = 30,
  uri,
}: {
  background: string;
  foreground: string;
  label: string;
  size?: number;
  uri?: string | undefined;
}) {
  const styles = useStyles(makeStyles);
  const [failed, setFailed] = useState<string | null>(null);
  return (
    <View
      style={[
        styles.avatar,
        { backgroundColor: background, borderRadius: size / 2, height: size, width: size },
      ]}
    >
      <Text
        maxFontSizeMultiplier={BOX_FONT_SCALE}
        style={[styles.avatarLabel, { color: foreground, fontSize: Math.round(size * 0.44) }]}
      >
        {label}
      </Text>
      {uri !== undefined && failed !== uri ? (
        <Image
          accessibilityIgnoresInvertColors
          onError={() => setFailed(uri)}
          source={{ uri }}
          style={[StyleSheet.absoluteFill, { borderRadius: size / 2 }]}
        />
      ) : null}
    </View>
  );
}

/** A calendar's or list's color as a circle, filled with a check while it is shown. */
export function ColorCheck({ color, visible }: { color: string; visible: boolean }) {
  const styles = useStyles(makeStyles);
  return (
    <View
      style={[
        styles.colorCheck,
        { backgroundColor: visible ? color : 'transparent', borderColor: color },
      ]}
    >
      {visible ? (
        <Glyph name="checkmark" size={12} tintColor={chipTextColor(color)} weight="bold" />
      ) : null}
    </View>
  );
}

/**
 * A calendar or list: tapping it shows or hides it, the ⓘ (when given)
 * opens its page. Two buttons side by side rather than one inside the
 * other, so VoiceOver and Maestro reach both.
 */
export function VisibilityRow({
  color,
  disabled = false,
  infoLabel,
  infoTestID,
  onInfo,
  onToggle,
  subtitle,
  testID,
  title,
  visible,
}: {
  color: string;
  disabled?: boolean;
  infoLabel?: string;
  infoTestID?: string;
  onInfo?: () => void;
  onToggle: () => void;
  subtitle?: string;
  testID: string;
  title: string;
  visible: boolean;
}) {
  const { colors } = useTheme();
  const styles = useStyles(makeStyles);
  const first = useContext(FirstRowContext);
  return (
    <View style={styles.visibilityRow}>
      <Pressable
        accessibilityLabel={subtitle ? `${title}, ${subtitle}` : title}
        accessibilityRole="checkbox"
        accessibilityState={{ checked: visible, disabled }}
        disabled={disabled}
        onPress={onToggle}
        style={({ pressed }) => [styles.visibilityToggle, pressed && styles.pressed]}
        testID={testID}
      >
        <View style={styles.leading}>
          <ColorCheck color={color} visible={visible} />
        </View>
        <View style={[styles.body, !first && styles.separator]}>
          <View style={styles.text}>
            <Text style={styles.title}>{title}</Text>
            {subtitle ? <Text style={styles.subtitle}>{subtitle}</Text> : null}
          </View>
        </View>
      </Pressable>
      {onInfo ? (
        <Pressable
          accessibilityLabel={infoLabel}
          accessibilityRole="button"
          onPress={onInfo}
          style={({ pressed }) => [
            styles.info,
            !first && styles.separator,
            pressed && styles.pressed,
          ]}
          testID={infoTestID}
        >
          <Glyph name="info.circle" size={22} tintColor={colors.primary} />
        </Pressable>
      ) : null}
    </View>
  );
}

/** A small tinted capsule button inside a row ("Connect", "Allow Access"). */
export function CapsuleButton({
  disabled = false,
  label,
  onPress,
  testID,
}: {
  disabled?: boolean;
  label: string;
  onPress: () => void;
  testID?: string;
}) {
  const styles = useStyles(makeStyles);
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ disabled }}
      disabled={disabled}
      hitSlop={6}
      onPress={onPress}
      style={({ pressed }) => [
        styles.capsule,
        pressed && styles.capsulePressed,
        disabled && styles.disabled,
      ]}
      testID={testID}
    >
      <Text style={styles.capsuleLabel}>{label}</Text>
    </Pressable>
  );
}

const makeStyles = (colors: ThemeColors) =>
  StyleSheet.create({
    avatar: {
      alignItems: 'center',
      justifyContent: 'center',
    },
    avatarLabel: {
      fontWeight: '600',
    },
    // Grows with the count's text size rather than clipping it.
    badge: {
      alignItems: 'center',
      backgroundColor: colors.danger,
      borderRadius: 11,
      justifyContent: 'center',
      minHeight: 22,
      minWidth: 22,
      paddingHorizontal: 7,
    },
    badgeLabel: {
      color: colors['on-danger'],
      fontSize: 14,
      fontWeight: '600',
    },
    body: {
      alignItems: 'center',
      alignSelf: 'stretch',
      flex: 1,
      flexDirection: 'row',
      gap: 8,
      minHeight: 52,
      paddingRight: 16,
    },
    // Grows with its label's text size rather than clipping it.
    capsule: {
      backgroundColor: colors.selection,
      borderRadius: 16,
      justifyContent: 'center',
      minHeight: 32,
      paddingHorizontal: 14,
    },
    capsuleLabel: {
      color: colors['on-selection'],
      fontSize: 15,
      fontWeight: '600',
    },
    capsulePressed: {
      opacity: 0.6,
    },
    // Inset like a row's text, so the separator above it starts there too.
    caption: {
      color: colors['text-secondary'],
      fontSize: 13,
      lineHeight: 18,
      marginLeft: 16,
      paddingBottom: 4,
      paddingRight: 16,
      paddingTop: 12,
    },
    card: {
      backgroundColor: colors.surface,
      borderRadius: 20,
      marginHorizontal: 16,
      overflow: 'hidden',
    },
    cardBottom: {
      borderBottomLeftRadius: 20,
      borderBottomRightRadius: 20,
    },
    cardRow: {
      backgroundColor: colors.surface,
      marginHorizontal: 16,
      overflow: 'hidden',
    },
    cardTop: {
      borderTopLeftRadius: 20,
      borderTopRightRadius: 20,
    },
    centered: {
      textAlign: 'center',
    },
    checkSpace: {
      width: 17,
    },
    chips: {
      flexDirection: 'row',
      flexWrap: 'wrap',
      gap: 8,
    },
    colorCheck: {
      alignItems: 'center',
      borderRadius: 12,
      borderWidth: 2,
      height: 24,
      justifyContent: 'center',
      width: 24,
    },
    content: {
      paddingBottom: 48,
      paddingTop: 8,
    },
    danger: {
      color: colors.danger,
    },
    // Indented to a row's text: the leading column (30) and its gap (14).
    detail: {
      gap: 8,
      paddingBottom: 12,
      paddingLeft: 60,
      paddingRight: 16,
    },
    detailBefore: {
      color: colors['text-secondary'],
      textDecorationLine: 'line-through',
    },
    detailEmpty: {
      color: colors['text-secondary'],
      fontSize: 15,
      lineHeight: 20,
    },
    detailLabel: {
      color: colors['text-secondary'],
      fontSize: 13,
      lineHeight: 18,
    },
    detailLine: {
      gap: 1,
    },
    detailValue: {
      color: colors.text,
      fontSize: 15,
      lineHeight: 20,
    },
    disabled: {
      opacity: 0.4,
    },
    dot: {
      borderRadius: 7,
      height: 14,
      width: 14,
    },
    experimental: {
      alignItems: 'center',
      gap: 6,
      marginTop: 6,
    },
    experimentalNote: {
      color: colors['text-secondary'],
      fontSize: 13,
      lineHeight: 18,
      textAlign: 'center',
    },
    // The field's own padding makes the row's height (a 17 pt line in 52 pt).
    field: {
      color: colors.text,
      fontSize: 17,
      minHeight: 52,
      paddingRight: 16,
      paddingVertical: 15,
    },
    fieldMultiline: {
      minHeight: 100,
      paddingTop: 14,
      textAlignVertical: 'top',
    },
    // Inset like a row's text, so the separator above it starts there too.
    fieldRow: {
      marginLeft: 16,
    },
    footer: {
      color: colors['text-secondary'],
      fontSize: 13,
      lineHeight: 18,
      marginTop: 7,
      paddingHorizontal: 32,
    },
    header: {
      color: colors['text-secondary'],
      fontSize: 13,
      lineHeight: 18,
      marginBottom: 7,
      paddingHorizontal: 32,
      textTransform: 'uppercase',
    },
    hero: {
      alignItems: 'center',
      backgroundColor: colors.surface,
      borderRadius: 20,
      gap: 6,
      marginHorizontal: 16,
      marginTop: 8,
      paddingHorizontal: 20,
      paddingVertical: 20,
    },
    heroSubtitle: {
      color: colors['text-secondary'],
      fontSize: 15,
      lineHeight: 20,
      textAlign: 'center',
    },
    heroTitle: {
      color: colors.text,
      fontSize: 22,
      fontWeight: '700',
      textAlign: 'center',
    },
    info: {
      alignItems: 'center',
      alignSelf: 'stretch',
      justifyContent: 'center',
      width: 56,
    },
    leading: {
      marginRight: 14,
    },
    page: {
      backgroundColor: groupedGround(colors),
      flex: 1,
    },
    pressed: {
      backgroundColor: colors.border,
    },
    row: {
      alignItems: 'center',
      flexDirection: 'row',
      minHeight: 52,
      paddingLeft: 16,
    },
    section: {
      marginTop: 28,
    },
    sectionTight: {
      marginTop: 20,
    },
    separator: {
      borderTopColor: colors.border,
      borderTopWidth: StyleSheet.hairlineWidth,
    },
    // Inset like a row's text, so the separator above it starts there too.
    slot: {
      gap: 10,
      marginLeft: 16,
      paddingRight: 16,
      paddingVertical: 13,
    },
    subtitle: {
      color: colors['text-secondary'],
      fontSize: 15,
      lineHeight: 20,
    },
    swipeAction: {
      alignItems: 'center',
      backgroundColor: colors.danger,
      justifyContent: 'center',
      width: 92,
    },
    swipeActionLabel: {
      color: colors['on-danger'],
      fontSize: 15,
      fontWeight: '600',
    },
    swipeContent: {
      backgroundColor: colors.surface,
    },
    tag: {
      backgroundColor: colors.fill,
      borderRadius: 999,
      paddingHorizontal: 10,
      paddingVertical: 3,
    },
    tagLabel: {
      color: colors['text-secondary'],
      fontSize: 13,
      fontWeight: '600',
    },
    text: {
      flex: 1,
      paddingVertical: 11,
    },
    tile: {
      alignItems: 'center',
      justifyContent: 'center',
    },
    tileSpace: {
      alignItems: 'center',
      justifyContent: 'center',
      width: 30,
    },
    tint: actionText(colors),
    title: {
      color: colors.text,
      fontSize: 17,
      lineHeight: 22,
    },
    value: {
      color: colors['text-secondary'],
      flexShrink: 1,
      fontSize: 17,
      textAlign: 'right',
    },
    visibilityRow: {
      alignItems: 'stretch',
      flexDirection: 'row',
      minHeight: 52,
    },
    visibilityToggle: {
      alignItems: 'center',
      flex: 1,
      flexDirection: 'row',
      paddingLeft: 16,
    },
    warning: {
      color: colors.warning,
    },
  });
