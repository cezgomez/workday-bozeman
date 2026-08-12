import { XMLParser } from 'fast-xml-parser';

/**
 * Personal API (requirements lines 1383–1444):
 *   - Source: Staffing Get_Workers Include_Worker_Documents
 *   - Path: Personal/100_{EmployeeID}_{Workday_Owned_ID}_{Filename}
 *   - Exclude: CERT, LICENSES, EDUCATION
 *   - Skip when Document_Category__Workday_Owned__ID is missing
 */

/** Categories never uploaded for Personal */
export const PERSONAL_EXCLUDED_CATEGORIES = new Set([
  'CERT',
  'LICENSES',
  'EDUCATION',
]);

const soapParser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  textNodeName: '#text',
  isArray: (name) =>
    [
      'Worker',
      'Worker_Document',
      'ID',
      'wd:Worker',
      'wd:Worker_Document',
      'wd:ID',
    ].includes(name),
  removeNSPrefix: true,
});

/**
 * Parse Staffing Get_Workers SOAP for Personal-eligible worker documents.
 *
 * @param {string} soapXml
 * @returns {{
 *   workerId: string,
 *   documents: Array<{
 *     wid: string,
 *     fileId: string,
 *     filename: string,
 *     categoryOwnedId: string,
 *     fileBase64: string
 *   }>,
 *   skippedNoCategory: number,
 *   skippedExcluded: number
 * }}
 */
export function parsePersonalWorkerDocumentsSoap(soapXml) {
  const parsed = soapParser.parse(soapXml);
  const envelope = parsed?.Envelope ?? parsed?.['soapenv:Envelope'] ?? parsed;
  const body = envelope?.Body ?? envelope?.['soapenv:Body'] ?? envelope;
  const response =
    body?.Get_Workers_Response ??
    body?.['wd:Get_Workers_Response'] ??
    body;
  const responseData = response?.Response_Data ?? response;
  const workers = asArray(responseData?.Worker);

  let workerId = '';
  const documents = [];
  let skippedNoCategory = 0;
  let skippedExcluded = 0;
  const seenWids = new Set();
  const seenNames = new Set();

  for (const worker of workers) {
    const workerData = worker?.Worker_Data ?? worker;
    workerId =
      textOf(workerData?.Worker_ID) ||
      textOf(workerData?.User_ID) ||
      workerId;

    const docData = workerData?.Worker_Document_Data ?? workerData;
    for (const doc of asArray(docData?.Worker_Document)) {
      const ref = doc?.Worker_Document_Reference ?? {};
      const wid = idOfType(ref, 'WID');
      const fileId = idOfType(ref, 'File_ID');
      const detail = doc?.Worker_Document_Detail_Data ?? doc;
      const catRef = detail?.Document_Category_Reference ?? {};
      const categoryOwnedId = idOfType(
        catRef,
        'Document_Category__Workday_Owned__ID'
      );
      const filename = textOf(detail?.Filename);
      const fileBase64 = textOf(detail?.File);

      if (!fileBase64) continue;

      // Requirement: If there is no Category, do not upload
      if (!categoryOwnedId) {
        skippedNoCategory += 1;
        continue;
      }

      const categoryKey = String(categoryOwnedId).trim().toUpperCase();
      // Requirement: Do not include CERT, LICENSES, EDUCATION
      if (PERSONAL_EXCLUDED_CATEGORIES.has(categoryKey)) {
        skippedExcluded += 1;
        continue;
      }

      if (wid && seenWids.has(wid)) continue;
      const nameKey = `${categoryKey}::${(filename || '').trim().toLowerCase()}`;
      if (nameKey && seenNames.has(nameKey)) continue;
      if (wid) seenWids.add(wid);
      if (nameKey) seenNames.add(nameKey);

      documents.push({
        wid,
        fileId,
        filename: filename || 'document.pdf',
        // preserve original casing from Workday for path prefix
        categoryOwnedId: String(categoryOwnedId).trim(),
        fileBase64,
      });
    }
  }

  return { workerId, documents, skippedNoCategory, skippedExcluded };
}

/**
 * Category segment for file name: remove spaces only (keep underscores in IDs).
 * e.g. "BACKGROUND CHECK" → "BACKGROUNDCHECK"
 *      "CANDIDATE_RESUME_AND_COVER_LETTER" → "CANDIDATE_RESUME_AND_COVER_LETTER"
 */
export function sanitizePersonalCategoryPart(categoryOwnedId) {
  return String(categoryOwnedId || 'UNKNOWN')
    .trim()
    .replace(/\s+/g, '')
    .replace(/[<>:"/\\|?*]/g, '');
}

/**
 * Fast extract of EmployeeID values from RaaS XML.
 * @param {string} xml
 * @returns {string[]}
 */
export function extractEmployeeIdsFromReportXml(xml) {
  const ids = new Set();
  const re = /<(?:wd:)?EmployeeID[^>]*>([^<]+)<\/(?:wd:)?EmployeeID>/gi;
  let m;
  while ((m = re.exec(xml)) !== null) {
    const id = String(m[1]).trim();
    if (id) ids.add(id);
  }
  return [...ids];
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

function idOfType(node, typeName) {
  if (!node) return '';
  for (const id of asArray(node.ID)) {
    const t = id?.['@_type'] || id?.['@_wd:type'] || '';
    if (String(t) === typeName) return textOf(id);
  }
  return '';
}
