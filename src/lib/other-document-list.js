import { XMLParser } from 'fast-xml-parser';

/**
 * Directory criteria (requirements lines 676–707).
 *
 * - Background Check: Document_Category owned ID = BACKGROUND CHECK
 * - Reference: Reference Letter category AND filename does NOT contain SKILL
 * - Skill Survey: Reference Letter category AND filename contains SKILL
 * - Exclusion Check: Onboarding category AND filename has EC token
 */
export const OTHER_DOCUMENT_CRITERIA = [
  'Background Check',
  'Reference',
  'Skill Survey',
  'Exclusion Check',
];

/** Directory name (spaces → _) and file prefix (spaces removed) per criteria */
export const CRITERIA_NAMING = {
  'Background Check': { directoryName: 'Background_Check', filePrefix: 'BackgroundCheck' },
  Reference: { directoryName: 'Reference', filePrefix: 'Reference' },
  'Skill Survey': { directoryName: 'Skill_Survey', filePrefix: 'SkillSurvey' },
  'Exclusion Check': { directoryName: 'Exclusion_Check', filePrefix: 'ExclusionCheck' },
};

const listParser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  textNodeName: '#text',
  isArray: (name) =>
    [
      'Report_Entry',
      'Candidate_from_Worker_group',
      'wd:Report_Entry',
      'wd:Candidate_from_Worker_group',
    ].includes(name),
  removeNSPrefix: true,
});

const soapParser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  textNodeName: '#text',
  isArray: (name) =>
    [
      'Candidate_Attachment',
      'Candidate_Attachment_Data',
      'ID',
      'wd:Candidate_Attachment',
      'wd:Candidate_Attachment_Data',
      'wd:ID',
    ].includes(name),
  removeNSPrefix: true,
});

/**
 * Parse API_Candidate_from_Worker RaaS → Employee_ID + Candidate_ID pairs.
 *
 * @returns {Array<{ employeeId: string, fullName: string, workdayId: string, candidateId: string }>}
 */
export function parseCandidateFromWorkerList(xmlString) {
  const parsed = listParser.parse(xmlString);
  const reportData = parsed?.Report_Data ?? parsed;
  const entries = asArray(reportData?.Report_Entry);
  const rows = [];

  for (const entry of entries) {
    const employeeId =
      textOf(entry.Employee_ID) || textOf(entry.EmployeeID) || textOf(entry.EmployeeId);
    if (!employeeId) continue;
    const fullName =
      textOf(entry.Full_Name) || textOf(entry.FullName) || textOf(entry.Fullname);
    const workdayId = textOf(entry.workdayID) || textOf(entry.WorkdayID);

    for (const group of asArray(entry.Candidate_from_Worker_group)) {
      const candidateId = textOf(group.Candidate_ID) || textOf(group.CandidateID);
      if (!candidateId) continue;
      rows.push({ employeeId, fullName, workdayId, candidateId });
    }
  }

  return rows;
}

/**
 * Parse Get_Candidate_Attachments SOAP → attachment records with base64.
 *
 * @returns {Array<{
 *   filename: string,
 *   fileBase64: string,
 *   categoryOwnedId: string,
 *   categoryId: string,
 *   categoryDescriptor: string,
 *   criteria: string|null
 * }>}
 */
export function parseCandidateAttachmentsSoap(soapXml) {
  const parsed = soapParser.parse(soapXml);
  const envelope = parsed?.Envelope ?? parsed;
  const body = envelope?.Body ?? envelope;
  const response =
    body?.Get_Candidate_Attachments_Response ??
    body?.['wd:Get_Candidate_Attachments_Response'] ??
    body;
  const responseData = response?.Response_Data ?? response;
  const attachments = asArray(responseData?.Candidate_Attachment);

  const docs = [];

  for (const att of attachments) {
    for (const data of asArray(att?.Candidate_Attachment_Data)) {
      const ad = data?.Attachment_Data ?? data;
      const filename = decodeEntities(textOf(ad?.Filename) || 'attachment.pdf');
      const fileBase64 = textOf(ad?.File_Content) || textOf(ad?.File) || '';
      if (!fileBase64) continue;

      const catRef =
        data?.Document_Category_Reference ||
        ad?.Document_Category_Reference ||
        {};
      const categoryOwnedId = idOfType(catRef, 'Document_Category__Workday_Owned__ID');
      const categoryId = idOfType(catRef, 'Document_Category_ID');
      const categoryDescriptor = descriptorOf(catRef);

      const criteria = classifyOtherDocument({
        categoryOwnedId,
        categoryId,
        categoryDescriptor,
        filename,
      });

      docs.push({
        filename,
        fileBase64,
        categoryOwnedId,
        categoryId,
        categoryDescriptor,
        criteria,
      });
    }
  }

  return docs;
}

/**
 * Classify attachment into one of the Other Document directories, or null.
 *
 * Skill Survey note (requirements): filename contains *SKILL*.
 * In live data these are usually category ASSESSMENT with names like
 *   Skillsurvey_Reference_Jane_Doe.pdf
 * — not Document_Category = Reference Letter. Match by filename first.
 */
export function classifyOtherDocument({
  categoryOwnedId,
  categoryId,
  categoryDescriptor,
  filename,
}) {
  const ownedRaw = String(categoryOwnedId || '').trim();
  const ownedNorm = ownedRaw.toUpperCase().replace(/_/g, ' ').replace(/\s+/g, ' ').trim();
  const cat = String(categoryId || categoryDescriptor || '').trim();
  // Decode common XML/HTML entities so O&#39;Brien / &amp; match cleanly
  const name = decodeEntities(String(filename || ''));

  // Skill Survey: filename contains SKILL / Skillsurvey (requirements note "*SKILL")
  // Live category is often ASSESSMENT, not Reference Letter.
  if (hasSkillToken(name)) {
    return 'Skill Survey';
  }

  // Background Check
  if (ownedNorm === 'BACKGROUND CHECK' || ownedNorm.includes('BACKGROUND CHECK')) {
    return 'Background Check';
  }

  // Reference Letter (no SKILL in filename — those already returned as Skill Survey)
  const isReferenceLetter =
    ownedRaw.toUpperCase() === 'REFERENCE_LETTER' ||
    ownedNorm === 'REFERENCE LETTER' ||
    /reference\s*letter/i.test(cat) ||
    /^reference$/i.test(cat);

  if (isReferenceLetter) {
    return 'Reference';
  }

  // Exclusion Check: Onboarding + filename has EC token
  const isOnboarding =
    /onboarding/i.test(cat) ||
    ownedNorm === 'ONBOARDING' ||
    ownedRaw.toUpperCase() === 'ONBOARDING';

  if (isOnboarding && hasEcToken(name)) {
    return 'Exclusion Check';
  }

  return null;
}

/** Filename contains Skill / Skillsurvey (case-insensitive). */
export function hasSkillToken(filename) {
  return /skill/i.test(String(filename || ''));
}

function decodeEntities(value) {
  return String(value)
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#39;/g, "'")
    .replace(/&#x27;/gi, "'");
}

/**
 * Filename contains EC as a token (e.g. Shannon.Dejong.EC.pdf, EC - Julie.pdf, EC- Amy.pdf).
 * Avoids matching "EC" inside longer words when possible.
 */
export function hasEcToken(filename) {
  const name = String(filename || '');
  if (/(^|[^A-Za-z0-9])EC([^A-Za-z0-9]|$)/i.test(name)) return true;
  if (/\.EC\./i.test(name)) return true;
  if (/EC\.(pdf|png|jpg|jpeg|tif|tiff|doc|docx)$/i.test(name)) return true;
  return false;
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
