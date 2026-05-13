/**
 * ResponseIdCell — small, reusable cell for rendering a Firestore response
 * document ID inline in a table column. Shows the full id in a monospace
 * pill (so it's unambiguous when copy-pasted into bug reports or support
 * tickets) with a one-click copy button that flips to a check on success.
 *
 * Kept as its own module so both the admin Responses view and the
 * enumerator "My Responses" panel can use it without pulling each other's
 * heavier code into their respective bundles.
 */

import React, { useState } from 'react';
import { Check, Copy } from 'lucide-react';

interface ResponseIdCellProps {
  id: string;
  /**
   * `inline` (default) — full id rendered in a pill alongside a copy
   * button. Best for desktop admin tables.
   * `compact` — same content, with `break-all` and a smaller max-width,
   * keeps long ids from blowing out narrow phone-width columns on the
   * enumerator side.
   */
  variant?: 'inline' | 'compact';
}

export const ResponseIdCell: React.FC<ResponseIdCellProps> = ({
  id,
  variant = 'inline'
}) => {
  const [copied, setCopied] = useState(false);

  const handleCopy = async (e: React.MouseEvent) => {
    e.stopPropagation();
    try {
      // `navigator.clipboard` isn't available in some older browsers and
      // non-secure contexts (HTTP, embedded WebViews). Fall back to a
      // hidden <textarea> + execCommand for those — same behaviour, just
      // legacy plumbing.
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(id);
      } else {
        const ta = document.createElement('textarea');
        ta.value = id;
        ta.setAttribute('readonly', '');
        ta.style.position = 'absolute';
        ta.style.left = '-9999px';
        document.body.appendChild(ta);
        ta.select();
        document.execCommand('copy');
        document.body.removeChild(ta);
      }
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1400);
    } catch {
      /* swallow — silent failure is fine here */
    }
  };

  return (
    <div className="flex items-center gap-1.5 min-w-0">
      {variant === 'compact' ? (
        // Mobile / narrow-column variant — keep the id on a single line and
        // let the user swipe horizontally to read or copy it. Without
        // `overflow-x-auto` the column would force a wrap; with `break-all`
        // alone (the previous behaviour) each character ended up on its own
        // line on phone widths, which made the cell unusable.
        <div
          className="min-w-0 max-w-[180px] overflow-x-auto no-scrollbar"
          style={{ WebkitOverflowScrolling: 'touch' }}
        >
          <code
            className="font-mono text-[11px] text-slate-700 bg-slate-100 border border-slate-200 rounded px-1.5 py-0.5 whitespace-nowrap inline-block"
            title={id}
          >
            {id}
          </code>
        </div>
      ) : (
        <code
          className="font-mono text-[11px] text-slate-700 bg-slate-100 border border-slate-200 rounded px-1.5 py-0.5 whitespace-nowrap"
          title={id}
        >
          {id}
        </code>
      )}
      <button
        type="button"
        onClick={handleCopy}
        className={`shrink-0 p-1 rounded transition-colors ${
          copied
            ? 'text-emerald-600 bg-emerald-50'
            : 'text-slate-400 hover:text-slate-700 hover:bg-slate-100'
        }`}
        title={copied ? 'Copied!' : 'Copy full response ID'}
        aria-label="Copy response ID"
      >
        {copied ? <Check size={12} /> : <Copy size={12} />}
      </button>
    </div>
  );
};
