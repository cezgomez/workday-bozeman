import { XMLParser } from 'fast-xml-parser';

/**
 * Document category directories for Resume / Cover Letter API.
 * Classification is based on attachment / fileName text (requirements 1284–1289).
 */
export const RESUME_DOC_CATEGORIES = [
  'Resume',
  'Cover_Letter',
  'Recommendation_Letter',
  'CV',
];

const listParser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  textNodeName: '#text',
  isArray: (name) =>
    [
      'Report_Entry',
      'ResumeAttachment',
      'ID',
      'wd:Report_Entry',
      'wd:ResumeAttachment',
      'wd:ID',
    ].includes(name),
  removeNSPrefix: true,
});

/**
 * Parse list report (CR_Export_Resume_Letter_and_CV_-_Copy).
 * Multiple Report_Entry rows may exist per employee (per application).
 *
 * @returns {Array<{
 *   employeeId: string,
 *   fullName: string,
 *   workdayId: string,
 *   attachments: Array<{ resAttWid: string, fileName: string, category: string }>
 * }>}
 *   One row per unique employee; attachments = unique Descriptor per Category
 *   (first-seen order; same name in same category skipped).
 */
export function parseResumeCoverLetterListXml(xmlString) {
  const parsed = listParser.parse(xmlString);
  const reportData = parsed?.Report_Data ?? parsed;
  const entries = asArray(reportData?.Report_Entry);

  /** @type {Map<string, { employeeId: string, fullName: string, workdayId: string, raw: any[] }>} */
  const byEmp = new Map();

  for (const entry of entries) {
    const worker = entry.Worker_group ?? entry;
    const employeeId = textOf(worker.EmployeeID);
    if (!employeeId) continue;
    const fullName = textOf(worker.FullName) || textOf(worker.Fullname);
    const workdayId = textOf(worker.WID) || textOf(worker.workdayID);

    let emp = byEmp.get(employeeId);
    if (!emp) {
      emp = { employeeId, fullName, workdayId, raw: [] };
      byEmp.set(employeeId, emp);
    } else if (!emp.workdayId && workdayId) {
      emp.workdayId = workdayId;
    }

    for (const att of asArray(entry.ResumeAttachment)) {
      const resAttWid = textOf(att.ResAttWID);
      const fileName =
        textOf(att.fileName) ||
        descriptorOf(att.Attachment) ||
        'document.pdf';
      if (!resAttWid && !fileName) continue;
      emp.raw.push({ resAttWid, fileName });
    }
  }

  const result = [];
  for (const emp of byEmp.values()) {
    const attachments = selectAttachmentsForEmployee(emp.raw);
    if (attachments.length === 0 || !emp.workdayId) continue;
    result.push({
      employeeId: emp.employeeId,
      fullName: emp.fullName,
      workdayId: emp.workdayId,
      attachments,
    });
  }
  return result;
}

/**
 * Select attachments for one employee:
 *   1 unique {Attachment Descriptor / fileName} per Employee per Category.
 *
 * - Classify each file into Resume / Cover_Letter / Recommendation_Letter / CV
 * - Within each category, keep the first occurrence of each unique descriptor name
 * - Same name appearing again (any later application) is skipped
 * - Different unique names in the same category are all kept
 */
export function selectAttachmentsForEmployee(rawAttachments) {
  /** @type {Set<string>} keys: `${category}::${normalizedName}` */
  const seenCategoryName = new Set();
  /** @type {Array<{ resAttWid: string, fileName: string, category: string }>} */
  const selected = [];

  for (const att of rawAttachments) {
    const nameKey = normalizeNameKey(att.fileName);
    if (!nameKey) continue;

    const category = classifyResumeDocument(att.fileName);
    const key = `${category}::${nameKey}`;
    // 1 per unique Attachment Descriptor per Employee per Category
    if (seenCategoryName.has(key)) continue;
    seenCategoryName.add(key);

    selected.push({
      resAttWid: att.resAttWid,
      fileName: att.fileName,
      category,
    });
  }

  // Stable order by category group, preserving first-seen order within each
  const ordered = [];
  for (const cat of RESUME_DOC_CATEGORIES) {
    for (const att of selected) {
      if (att.category === cat) ordered.push(att);
    }
  }
  return ordered;
}

/**
 * Classify attachment descriptor / fileName into a directory category.
 */
export function classifyResumeDocument(fileName) {
  const name = decodeEntities(String(fileName || ''));
  const n = name.toLowerCase();

  // Cover letter (before "letter" alone)
  if (
    /cover\s*letter/i.test(name) ||
    /coverletter/i.test(n) ||
    /cover_letter/i.test(n)
  ) {
    return 'Cover_Letter';
  }

  // Recommendation / letter of rec
  if (
    /recommend/i.test(n) ||
    /letter\s*of\s*rec/i.test(n) ||
    /reference\s*letter/i.test(n) ||
    /lor\b/i.test(n)
  ) {
    return 'Recommendation_Letter';
  }

  // CV (word boundary-ish)
  if (
    /(^|[^a-z])cv([^a-z]|$)/i.test(n) ||
    /curriculum\s*vitae/i.test(n)
  ) {
    return 'CV';
  }

  // Resume
  if (/resume|résumé|resumé/i.test(name)) {
    return 'Resume';
  }

  // Default
  return 'Resume';
}

/**
 * Parse detail report with activeAttachmentContent base64.
 *
 * @returns {Map<string, { fileName: string, base64: string, employeeId: string }>}
 *   keyed by ResAttWID
 */
export function parseResumeCoverLetterDetailXml(xmlString) {
  const parsed = listParser.parse(xmlString);
  const reportData = parsed?.Report_Data ?? parsed;
  const entries = asArray(reportData?.Report_Entry);
  /** @type {Map<string, object>} */
  const byWid = new Map();

  for (const entry of entries) {
    const worker = entry.Worker_group ?? entry;
    const employeeId = textOf(worker.EmployeeID);

    for (const att of asArray(entry.ResumeAttachment)) {
      const resAttWid =
        textOf(att.ResAttWID) || idOfType(att.Attachment, 'WID');
      const fileName =
        textOf(att.fileName) ||
        descriptorOf(att.Attachment) ||
        'document.pdf';
      const base64 =
        textOf(att.activeAttachmentContent) ||
        textOf(att.Base64) ||
        textOf(att.Attachment_Base64) ||
        '';
      if (!base64 || !resAttWid) continue;
      byWid.set(resAttWid, { fileName, base64, employeeId, resAttWid });
    }
  }

  return byWid;
}

export function normalizeNameKey(fileName) {
  return decodeEntities(String(fileName || ''))
    .toLowerCase()
    .replace(/\s+/g, '')
    .replace(/_/g, '')
    .trim();
}

function asArray(value) {
  if (value === undefined || value === null) return [];
  return Array.isArray(value) ? value : [value];
}

function textOf(node) {
  if (node === undefined || node === null) return '';
  if (typeof node === 'string' || typeof node === 'number') return String(node).trim();
  if (typeof node === 'object' && node['#text'] !== undefined) {
    return String(node['#text']).trim();
  }
  return '';
}

function descriptorOf(node) {
  if (!node) return '';
  if (typeof node === 'string') return node.trim();
  return String(node['@_Descriptor'] || node['@_wd:Descriptor'] || textOf(node) || '').trim();
}

function idOfType(node, typeName) {
  if (!node) return '';
  for (const id of asArray(node.ID)) {
    const t = id?.['@_type'] || id?.['@_wd:type'] || '';
    if (String(t) === typeName) return textOf(id);
  }
  return '';
}

function decodeEntities(value) {
  return String(value)
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#39;/g, "'");
}
