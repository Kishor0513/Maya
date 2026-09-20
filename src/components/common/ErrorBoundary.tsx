import { Component } from 'react';
import type { ReactNode } from 'react';

interface BoundaryState {
  error: Error | null;
}

// Catches render crashes anywhere below (e.g. a view switch that throws)
// and shows a recoverable screen instead of a silent blank page.
export class ErrorBoundary extends Component<{ children: ReactNode }, BoundaryState> {
  state: BoundaryState = { error: null };

  static getDerivedStateFromError(error: Error): BoundaryState {
    return { error };
  }

  componentDidCatch(error: Error): void {
    console.error('[Maya] UI crashed:', error);
  }

  render(): ReactNode {
    if (this.state.error) {
      return (
        <div
          role="alert"
          className="grid min-h-[100dvh] place-items-center bg-[#050505] p-6 text-center text-white"
        >
          <div className="max-w-sm">
            <p className="font-display text-3xl italic">Something glitched.</p>
            <p className="mt-2 text-sm text-zinc-400">
              Maya hit a UI error. Your conversations are safe.
            </p>
            <button
              type="button"
              onClick={() => window.location.reload()}
              className="mt-6 rounded-full bg-violet-300 px-6 py-2.5 text-sm font-medium text-black hover:bg-violet-200 focus:outline-none focus-visible:ring-2 focus-visible:ring-violet-200"
            >
              Reload Maya
            </button>
          </div>
        </div>
      );
    }
    return this.props.children;
  }
}
