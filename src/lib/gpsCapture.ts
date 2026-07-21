import type { GpsCaptureSettings } from '../types';

/** Accuracy gate is on unless explicitly disabled. */
export function gpsAccuracyGateEnabled(config: Pick<GpsCaptureSettings, 'accuracyEnabled'>): boolean {
  return config.accuracyEnabled !== false;
}

/** True when the sample may lock on accuracy (or when the gate is off). */
export function gpsMeetsAccuracy(
  config: Pick<GpsCaptureSettings, 'accuracyEnabled' | 'accuracyMeters'>,
  accuracy: number
): boolean {
  if (!gpsAccuracyGateEnabled(config)) return true;
  return accuracy <= config.accuracyMeters;
}

/** Short status line for GPS widget headers / canvas badges. */
export function gpsCaptureSummary(
  config: Pick<GpsCaptureSettings, 'accuracyEnabled' | 'accuracyMeters' | 'stabilizationSeconds'>
): string {
  const stab = `Stabilization ${config.stabilizationSeconds} s`;
  if (!gpsAccuracyGateEnabled(config)) return `${stab} • No accuracy gate`;
  return `Target accuracy ≤ ${config.accuracyMeters} m • ${stab}`;
}
