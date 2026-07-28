/**
 * Online / offline helpers for enumerator field work.
 * Response drafts & submissions queue via `offlineResponses.ts`.
 */

import {
  ensureOfflineFlushListener,
  isNetworkFailure
} from './offlineResponses';

export function isCapacitorNative(): boolean {
  return (
    typeof window !== 'undefined' &&
    (window as unknown as { Capacitor?: { isNativePlatform?: () => boolean } }).Capacitor
      ?.isNativePlatform?.() === true
  );
}

export function isBrowserOffline(): boolean {
  return typeof navigator !== 'undefined' && navigator.onLine === false;
}

export async function isDeviceOffline(): Promise<boolean> {
  return isBrowserOffline();
}

export { isNetworkFailure };

/** Prefer online write; callers that need local queue use geosurveyApi.saveResponse. */
export async function writeWithOfflineFallback<T>(
  writeFn: () => Promise<T>,
  _label: string
): Promise<T> {
  return writeFn();
}

export async function readQueryPreferCache<T>(readFn: () => Promise<T>): Promise<T> {
  return readFn();
}

/** Call once from app root so queued responses flush on reconnect. */
export function initOfflineSupport(): void {
  ensureOfflineFlushListener();
}
