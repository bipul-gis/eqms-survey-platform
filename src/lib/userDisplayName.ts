const toTitleCaseWords = (input: string): string =>
  input
    .trim()
    .split(/\s+/)
    .map((w) => (w ? w.charAt(0).toUpperCase() + w.slice(1).toLowerCase() : w))
    .join(' ');

/**
 * Prefer a real human name over an email-local "username" stored as displayName.
 * If `displayName` looks like an email handle (e.g. `bipul.paul`), derive words
 * from the email local part so consent text shows "Bipul Paul" instead of "bipul.paul".
 */
export function normalizedFullName(displayName: string | undefined, email: string): string {
  const raw = String(displayName || '').trim();
  const emailLocal = email.split('@')[0] || '';
  const rawKey = raw.toLowerCase();
  const emailKey = email.toLowerCase();
  const localKey = emailLocal.toLowerCase();
  const looksLikeEmailOrUsername =
    !raw ||
    rawKey === emailKey ||
    rawKey === localKey ||
    /^[a-z0-9._-]+$/i.test(raw);

  if (looksLikeEmailOrUsername) {
    const pretty = emailLocal.replace(/[._-]+/g, ' ').trim();
    return toTitleCaseWords(pretty || raw || email);
  }
  return toTitleCaseWords(raw);
}

/**
 * Resolved label for the signed-in user (profile + Auth), for consent placeholders
 * and similar UI. Returns undefined when nothing meaningful is available.
 */
export function enumeratorResolvedDisplayName(
  userProfile: { displayName?: string; email?: string } | null | undefined,
  user: { displayName?: string | null; email?: string | null } | null | undefined
): string | undefined {
  const email = (userProfile?.email || user?.email || '').trim();
  const preferred =
    (userProfile?.displayName || '').trim() ||
    (user?.displayName || '').trim() ||
    '';
  const out = normalizedFullName(preferred || undefined, email).trim();
  return out.length > 0 ? out : undefined;
}
