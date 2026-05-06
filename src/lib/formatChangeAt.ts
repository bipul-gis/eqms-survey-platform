function parseToDate(v: unknown): Date | null {
  if (v instanceof Date && !Number.isNaN(v.getTime())) return v;
  if (typeof v === 'number' && Number.isFinite(v)) {
    const d = new Date(v);
    return Number.isNaN(d.getTime()) ? null : d;
  }
  if (typeof v === 'string') {
    const s = v.trim();
    if (!s) return null;
    const d = new Date(s);
    return Number.isNaN(d.getTime()) ? null : d;
  }
  if (typeof v === 'object' && v !== null) {
    const o = v as { toDate?: () => Date; seconds?: number; nanoseconds?: number };
    if (typeof o.toDate === 'function') {
      try {
        const d = o.toDate();
        return Number.isNaN(d.getTime()) ? null : d;
      } catch {
        return null;
      }
    }
    if (typeof o.seconds === 'number') {
      const d = new Date(o.seconds * 1000);
      return Number.isNaN(d.getTime()) ? null : d;
    }
  }
  return null;
}

/**
 * Human-readable local date/time for ChangeAt (not ISO-8601).
 * Example: "6 May 2026, 3:45:12 pm" (exact style depends on browser locale).
 */
export function formatChangeAtReadable(v: unknown): string {
  const d = parseToDate(v);
  if (!d) {
    if (typeof v === 'string') {
      const t = v.trim();
      return t;
    }
    return '';
  }
  return d.toLocaleString(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    second: '2-digit',
    hour12: true
  });
}
