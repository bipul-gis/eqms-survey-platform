/**
 * Permission-grant paragraph may include a placeholder that is replaced
 * with the signed-in enumerator's display name at runtime (when enabled
 * on the questionnaire).
 */
const PLACEHOLDERS = ['{{enumeratorName}}', '{{enumerator_name}}'] as const;

/**
 * Replace enumerator name tokens in consent text or checkbox labels.
 * When `substitute` is false, the template is returned unchanged.
 */
export function formatConsentGateTemplate(
  template: string,
  enumeratorDisplayName: string | undefined | null,
  substitute = true
): string {
  if (!substitute) return template;
  const name = (enumeratorDisplayName ?? '').trim();
  const replacement = name || '(enumerator name)';
  let out = template;
  for (const ph of PLACEHOLDERS) {
    out = out.split(ph).join(replacement);
  }
  return out;
}
