/**
 * AppFooter — single-line copyright + author credit for every screen.
 *
 * Designed to slot into card-based layouts (LoginScreen, admin home,
 * enumerator chooser, status pages) without breaking the existing vertical
 * rhythm. For the full-screen geospatial / map view we render the `inline`
 * variant — a tiny pill the map can overlap without losing legibility.
 *
 * Why one component for two surfaces: copy and attribution must stay in
 * lockstep across the web app and the Android shell. Centralising it here
 * means future tweaks (e.g. swapping in a versioned build hash) are a
 * one-file change.
 */
import React from 'react';

interface AppFooterProps {
  /**
   * `card` — default, intended for layouts with a normal flow at the bottom
   * of the screen (login, chooser cards, status pages).
   * `inline` — tighter, semi-transparent; safe to drop into headers /
   * floating overlays so it doesn't fight with map controls.
   */
  variant?: 'card' | 'inline';
  className?: string;
}

export const AppFooter: React.FC<AppFooterProps> = ({
  variant = 'card',
  className = ''
}) => {
  if (variant === 'inline') {
    return (
      <div
        className={`text-[10px] text-slate-500 leading-tight flex items-center gap-1.5 whitespace-nowrap ${className}`}
        aria-label="App attribution"
      >
        <span>© EQMS</span>
        <span className="text-slate-300">·</span>
        <span>
          Developed by <span className="font-semibold text-slate-600">Bipul Paul</span>
        </span>
      </div>
    );
  }

  return (
    <footer
      className={`pt-3 pb-2 text-center text-[11px] text-slate-500 leading-relaxed ${className}`}
      aria-label="App attribution"
    >
      <span className="inline-flex flex-wrap items-center justify-center gap-x-2 gap-y-0.5">
        <span>
          <span className="font-semibold text-slate-600">Copyright:</span> EQMS
        </span>
        <span className="text-slate-300">·</span>
        <span>
          <span className="font-semibold text-slate-600">Developed by:</span> Bipul Paul
        </span>
      </span>
    </footer>
  );
};
