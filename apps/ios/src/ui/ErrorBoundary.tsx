import { Component, type ReactNode } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { recordRenderError } from '../crashLog.ts';
import { type ThemeColors, useStyles } from './theme.ts';

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
    // Persisted for Settings › Advanced › Diagnostics: a TestFlight build
    // has no Metro console, so this file is the only artifact of a render
    // crash.
    recordRenderError(error);
    // eslint-disable-next-line no-console
    console.error('Uncaught render error', error);
  }

  override render() {
    if (!this.state.error) {
      return this.props.children;
    }
    return <ErrorView error={this.state.error} onRetry={() => this.setState({ error: null })} />;
  }
}

/** The boundary is a class (React has no hook for it); the themed view is not. */
function ErrorView({ error, onRetry }: { error: Error; onRetry: () => void }) {
  const styles = useStyles(makeStyles);
  return (
    <View style={styles.container}>
      <Text style={styles.heading}>Something went wrong.</Text>
      <Text numberOfLines={3} selectable style={styles.detail}>
        {String(error)}
      </Text>
      <Pressable onPress={onRetry} style={styles.button}>
        <Text style={styles.buttonLabel}>Try again</Text>
      </Pressable>
    </View>
  );
}

const makeStyles = (colors: ThemeColors) =>
  StyleSheet.create({
    button: {
      backgroundColor: colors.primary,
      borderRadius: 8,
      paddingHorizontal: 16,
      paddingVertical: 6,
    },
    buttonLabel: {
      color: colors['on-primary'],
      fontSize: 14,
      fontWeight: '600',
    },
    container: {
      alignItems: 'center',
      backgroundColor: colors.canvas,
      flex: 1,
      gap: 12,
      justifyContent: 'center',
      paddingHorizontal: 24,
    },
    detail: {
      color: colors['text-secondary'],
      fontSize: 13,
      textAlign: 'center',
    },
    heading: {
      color: colors.text,
      fontSize: 17,
      fontWeight: '600',
    },
  });
