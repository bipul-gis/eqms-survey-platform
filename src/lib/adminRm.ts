/**
 * Append a timestamped admin audit line for operational tasks (import, merge, QC, moves).
 * Multiple actions accumulate as newline-separated history.
 */
export function appendAdminRm(existing: string | undefined, action: string, adminEmail: string): string {
  const ts = new Date().toISOString();
  const email = (adminEmail || '').trim() || 'admin';
  const line = `[${ts}] ${action} (${email})`;
  const prev = String(existing ?? '').trim();
  return prev ? `${prev}\n${line}` : line;
}
