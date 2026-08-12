/**
 * Normalize text for loose document matching:
 * lower-case, strip non-alphanumerics, collapse whitespace variants.
 */
export function normalizeName(value = '') {
  return String(value)
    .toLowerCase()
    .replace(/&amp;/g, '&')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .replace(/\s+/g, ' ');
}

/**
 * Flexible match: exact normalized equality, or either side contains the other.
 * Handles BH- prefixes, spelling variants (Acknowlegement/Acknowledgement), etc.
 */
export function namesMatch(actual, expected) {
  const a = normalizeName(actual);
  const e = normalizeName(expected);
  if (!a || !e) return false;
  if (a === e) return true;
  if (a.includes(e) || e.includes(a)) return true;

  // Compare without common leading "bh " noise
  const stripBh = (s) => s.replace(/^bh\s+/, '');
  const a2 = stripBh(a);
  const e2 = stripBh(e);
  if (a2 === e2) return true;
  if (a2.includes(e2) || e2.includes(a2)) return true;

  return false;
}

/**
 * Returns true when category + document descriptor match the configured filters.
 */
export function isAllowedDocument(categoryDescriptor, documentDescriptor, filters) {
  if (!categoryDescriptor || !documentDescriptor) return false;

  for (const rule of filters) {
    if (normalizeName(categoryDescriptor) !== normalizeName(rule.category)) {
      continue;
    }
    for (const docName of rule.documents) {
      if (namesMatch(documentDescriptor, docName)) {
        return true;
      }
    }
  }
  return false;
}
