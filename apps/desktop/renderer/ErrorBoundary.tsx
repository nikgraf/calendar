import { Component, type ReactNode } from 'react';

interface State {
  readonly error: Error | null;
}

/** Last line of defense: an uncaught render error must not white-screen. */
export class ErrorBoundary extends Component<{ children: ReactNode }, State> {
  override state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  override componentDidCatch(error: Error): void {
    window.calendarBridge.logError?.(`${String(error)}\n${error.stack ?? ''}`);
  }

  override render() {
    if (!this.state.error) {
      return this.props.children;
    }
    return (
      <div className="flex h-screen flex-col items-center justify-center gap-3 bg-neutral-50">
        <p className="text-lg font-semibold">Something went wrong.</p>
        <p className="max-w-md select-text truncate text-sm text-neutral-500">
          {String(this.state.error)}
        </p>
        <button
          className="rounded-lg bg-blue-600 px-4 py-1.5 text-sm font-medium text-white hover:bg-blue-500"
          onClick={() => window.location.reload()}
          type="button"
        >
          Reload
        </button>
      </div>
    );
  }
}
