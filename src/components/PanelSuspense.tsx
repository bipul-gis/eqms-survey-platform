/**
 * Boundary for lazily-loaded side panels / overlays.
 *
 * Without a local Suspense boundary a lazy panel suspends up to the root
 * boundary, so opening it blanks the whole app until its chunk arrives — and
 * a failed chunk (or a render crash) leaves a permanently blank screen.
 */
import React, { Component, Suspense } from 'react';
import { AlertTriangle, X } from 'lucide-react';

const PanelFallback: React.FC<{ label: string }> = ({ label }) => (
  <div className="h-full w-[22rem] max-w-[100vw] bg-white border-l border-slate-200 shadow-xl flex items-center justify-center">
    <div className="flex items-center gap-3 text-slate-600">
      <div className="w-5 h-5 border-2 border-slate-300 border-t-blue-600 rounded-full animate-spin" />
      <span className="text-sm font-medium">{label}</span>
    </div>
  </div>
);

interface PanelErrorBoundaryProps {
  onClose?: () => void;
  children: React.ReactNode;
}

interface PanelErrorBoundaryState {
  error: Error | null;
}

// `@types/react` is not installed, so `Component` resolves to `any` and the
// inherited members need explicit declarations to stay type-checked here.
class PanelErrorBoundary extends Component {
  declare props: PanelErrorBoundaryProps;
  declare state: PanelErrorBoundaryState;
  declare setState: (state: PanelErrorBoundaryState) => void;

  constructor(props: PanelErrorBoundaryProps) {
    super(props);
    this.state = { error: null };
  }

  static getDerivedStateFromError(error: Error): PanelErrorBoundaryState {
    return { error };
  }

  componentDidCatch(error: Error, info: { componentStack?: string }) {
    console.error('Panel failed to render:', error, info?.componentStack);
  }

  render() {
    const { error } = this.state;
    if (!error) return this.props.children;
    return (
      <div className="h-full w-[22rem] max-w-[100vw] bg-white border-l border-slate-200 shadow-xl p-5 overflow-y-auto">
        <div className="flex items-start justify-between gap-2">
          <div className="flex items-center gap-2 text-red-600">
            <AlertTriangle size={18} />
            <h3 className="text-sm font-bold">Panel failed to load</h3>
          </div>
          {this.props.onClose && (
            <button
              type="button"
              onClick={this.props.onClose}
              className="p-1.5 text-slate-400 hover:text-slate-700 rounded-lg"
            >
              <X size={18} />
            </button>
          )}
        </div>
        <p className="mt-3 text-xs text-slate-600 leading-relaxed">
          Something went wrong opening this panel. Reload the page and try again — if it keeps
          happening, share the message below.
        </p>
        <pre className="mt-3 whitespace-pre-wrap break-words rounded-lg bg-slate-50 border border-slate-200 p-3 text-[11px] text-slate-700">
          {error.message}
        </pre>
        <button
          type="button"
          onClick={() => this.setState({ error: null })}
          className="mt-3 w-full py-2 rounded-lg bg-slate-800 text-white text-xs font-bold hover:bg-slate-900"
        >
          Try again
        </button>
      </div>
    );
  }
}

export const PanelSuspense: React.FC<{
  label?: string;
  onClose?: () => void;
  children: React.ReactNode;
}> = ({ label = 'Loading…', onClose, children }) => (
  <PanelErrorBoundary onClose={onClose}>
    <Suspense fallback={<PanelFallback label={label} />}>{children}</Suspense>
  </PanelErrorBoundary>
);
