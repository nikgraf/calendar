import { Component, type ReactNode } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { recordRenderError } from '../crashLog.ts';
import { palette } from './theme.ts';

interface State {
  readonly error: Error | null;
}

/**
 * Last line of defense: an uncaught render error must not blank the app.
 * Mirrors the desktop ErrorBoundary; RN has no window.reload, so "Try
 * again" clears the error and remounts the tree.
 */
export class ErrorBoundary extends Component<{ children: ReactNode }, State> {
  override state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  override componentDidCatch(error: Error): void {
    // Persisted for Settings › Diagnostics: a TestFlight build has no Metro
    // console, so this file is the only artifact of a render crash.
    recordRenderError(error);
    // eslint-disable-next-line no-console
    console.error('Uncaught render error', error);
  }

  override render() {
    if (!this.state.error) {
      return this.props.children;
    }
    return (
      <View style={styles.container}>
        <Text style={styles.heading}>Something went wrong.</Text>
        <Text numberOfLines={3} selectable style={styles.detail}>
          {String(this.state.error)}
        </Text>
        <Pressable onPress={() => this.setState({ error: null })} style={styles.button}>
          <Text style={styles.buttonLabel}>Try again</Text>
        </Pressable>
      </View>
    );
  }
}

const styles = StyleSheet.create({
  button: {
    backgroundColor: '#2563eb',
    borderRadius: 8,
    paddingHorizontal: 16,
    paddingVertical: 6,
  },
  buttonLabel: {
    color: '#ffffff',
    fontSize: 14,
    fontWeight: '600',
  },
  container: {
    alignItems: 'center',
    backgroundColor: palette.background,
    flex: 1,
    gap: 12,
    justifyContent: 'center',
    paddingHorizontal: 24,
  },
  detail: {
    color: palette.textMuted,
    fontSize: 13,
    textAlign: 'center',
  },
  heading: {
    color: palette.text,
    fontSize: 17,
    fontWeight: '600',
  },
});
