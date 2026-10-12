import type { ReactNode } from 'react';
import { ScrollView, type StyleProp, View, type ViewStyle } from 'react-native';

/**
 * A form's scroll view — or, `bare`, just its content, for a sheet that
 * owns the scroll view: the editor's form-sheet route keeps one across a
 * kind switch (react-native-screens lays a sheet out as a header and a
 * scroll view once, and a scroll view swapped in later lands on top of
 * the header). Keyboard insets: lower rows must scroll into reach above
 * the keyboard either way.
 */
export function FormScroll({
  bare = false,
  children,
  contentStyle,
  pointerEvents,
}: {
  bare?: boolean | undefined;
  children: ReactNode;
  contentStyle: StyleProp<ViewStyle>;
  pointerEvents?: 'auto' | 'none' | undefined;
}) {
  return bare ? (
    <View pointerEvents={pointerEvents} style={contentStyle}>
      {children}
    </View>
  ) : (
    <ScrollView
      automaticallyAdjustKeyboardInsets
      contentContainerStyle={contentStyle}
      keyboardShouldPersistTaps="handled"
      pointerEvents={pointerEvents}
    >
      {children}
    </ScrollView>
  );
}
