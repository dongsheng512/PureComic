import { Component, type ErrorInfo, type ReactNode } from "react";

type Props = { children: ReactNode };
type State = { error: Error | null };

export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.warn("ErrorBoundary", error, info.componentStack);
  }

  render() {
    if (!this.state.error) return this.props.children;
    return (
      <div className="flex h-full min-h-0 flex-col items-center justify-center gap-3 bg-paper px-6 text-center text-ink-800 dark:bg-surface dark:text-fg">
        <p className="text-sm">界面出了点问题，可以重新加载。</p>
        <button
          type="button"
          className="rounded-lg bg-ink-900 px-3 py-1.5 text-sm text-white dark:bg-white/15"
          onClick={() => window.location.reload()}
        >
          重新加载
        </button>
      </div>
    );
  }
}
