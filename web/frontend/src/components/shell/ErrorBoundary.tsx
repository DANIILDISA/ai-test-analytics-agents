// web/frontend/src/components/shell/ErrorBoundary.tsx
// App-wide error boundary: a thrown render error must NOT blank the whole page
// (React unmounts the tree on an uncaught error → white screen). Instead we catch
// it, show an honest Russian fallback with the message, and offer a way back.
import { Component, type ErrorInfo, type ReactNode } from "react";

interface Props {
  children: ReactNode;
  /** Bump this (e.g. with the route key) to clear the error when the user navigates. */
  resetKey?: string;
}

interface State {
  error: Error | null;
}

export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidUpdate(prev: Props) {
    // Navigating to another route clears the error so the app is usable again.
    if (this.state.error && prev.resetKey !== this.props.resetKey) {
      this.setState({ error: null });
    }
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    // Surface the component stack in the console for diagnosis.
    console.error("Сбой экрана:", error, info.componentStack);
  }

  render() {
    const { error } = this.state;
    if (!error) return this.props.children;

    return (
      <div className="flex h-full flex-col items-center justify-center bg-background px-8 py-16 text-center font-korpus">
        <div className="max-w-md">
          <h1 className="text-2xl font-bold text-foreground">Что-то пошло не так на этом экране</h1>
          <p className="mt-3 text-sm text-muted-foreground">
            Экран не удалось отобразить. Это сбой интерфейса, а не потеря данных — ваши анализы
            сохранены. Перейдите на другую вкладку или обновите страницу.
          </p>
          <pre className="mt-4 max-h-40 overflow-auto rounded-korpus border border-border bg-muted px-3 py-2 text-left text-xs text-korpus-down">
            {error.message || String(error)}
          </pre>
          <button
            type="button"
            onClick={() => this.setState({ error: null })}
            className="mt-5 rounded-korpus bg-korpus-blue px-5 py-2.5 text-sm font-medium text-white transition-colors hover:bg-korpus-blue/90"
          >
            Попробовать снова
          </button>
        </div>
      </div>
    );
  }
}
