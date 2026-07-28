/**
 * NetworkStatusBadge — compact pill that surfaces "Online / Syncing /
 * Offline" so enumerators always know whether their work is round-tripping
 * to Firestore or just queueing locally.
 *
 * UX rules:
 *   - Hide entirely when online & idle. (Don't add noise during the common
 *     case.)
 *   - Show an amber "Offline – saving locally" pill the moment the browser /
 *     WebView reports offline, so a tap on "Submit" doesn't feel like a
 *     mistake when it succeeds silently.
 *   - Show a slate "Syncing…" pill for a beat after reconnect, until
 *     Firestore reports the queue is drained.
 *
 * Kept dependency-free so it can be mounted in the global header without
 * pulling map / form chunks into the entry bundle.
 */
import React from 'react';
import { CloudOff, RefreshCw, Wifi } from 'lucide-react';
import { useOnlineStatus } from '../hooks/useOnlineStatus';

export const NetworkStatusBadge: React.FC<{ className?: string }> = ({
  className = ''
}) => {
  const { online, syncing, pendingCount } = useOnlineStatus();

  if (online && !syncing && pendingCount === 0) return null;

  if (!online) {
    return (
      <div
        className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-[11px] font-semibold bg-amber-100 text-amber-800 border border-amber-200 ${className}`}
        title="You're offline. Drafts and submissions are saved locally and will sync automatically when the connection returns."
      >
        <CloudOff size={12} className="shrink-0" />
        <span>Offline · saving locally</span>
      </div>
    );
  }

  // Online + syncing — show while the offline queue is flushing.
  return (
    <div
      className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-[11px] font-semibold bg-sky-100 text-sky-800 border border-sky-200 ${className}`}
      title="Connected. Uploading offline drafts and submissions."
    >
      <RefreshCw size={12} className="shrink-0 animate-spin" />
      <span>Syncing{pendingCount > 0 ? ` (${pendingCount})` : '…'}</span>
    </div>
  );
};

/**
 * Always-visible variant for surfaces that *want* the badge even on the
 * happy path — e.g. enumerator's "My Responses" panel, where confirming
 * "Online" reassures the user before they start a long survey.
 */
export const NetworkStatusBadgeAlways: React.FC<{ className?: string }> = ({
  className = ''
}) => {
  const { online, syncing, pendingCount } = useOnlineStatus();

  if (!online) {
    return (
      <div
        className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-[11px] font-semibold bg-amber-100 text-amber-800 border border-amber-200 ${className}`}
      >
        <CloudOff size={12} className="shrink-0" />
        <span>Offline · saving locally</span>
      </div>
    );
  }
  if (syncing || pendingCount > 0) {
    return (
      <div
        className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-[11px] font-semibold bg-sky-100 text-sky-800 border border-sky-200 ${className}`}
      >
        <RefreshCw size={12} className="shrink-0 animate-spin" />
        <span>Syncing{pendingCount > 0 ? ` (${pendingCount})` : '…'}</span>
      </div>
    );
  }
  return (
    <div
      className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-[11px] font-semibold bg-emerald-100 text-emerald-800 border border-emerald-200 ${className}`}
    >
      <Wifi size={12} className="shrink-0" />
      <span>Online</span>
    </div>
  );
};
