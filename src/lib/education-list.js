import { XMLParser } from 'fast-xml-parser';

const listParser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  textNodeName: '#text',
  isArray: (name) =>
    ['Report_Entry', 'Worker_Documents_group', 'wd:Report_Entry', 'wd:Worker_Documents_group'].includes(
      name
    ),
  removeNSPrefix: true,
});

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
 * Parse API_Education RaaS XML into employees + education doc metadata.
 *
 * Report shape:
 *   Report_Entry
 *     EmployeeID, FullName
 *     Worker_Documents_group[] { referenceID, DocCategory, Filename }
 *
 * @returns {Array<{
 *   employeeId: string,
 *   fullName: string,
 *   documents: Array<{ referenceId: string, filename: string, docCategory: string }>
 * }>}
 */
export function parseEducationListXml(xmlString) {
  const parsed = listParser.parse(xmlString);
  const reportData = parsed?.Report_Data ?? parsed;
  const entries = asArray(reportData?.Report_Entry);

  /** @type {Map<string, { employeeId: string, fullName: string, documents: any[] }>} */
  const byEmp = new Map();

  for (const entry of entries) {
    const employeeId = textOf(entry.EmployeeID);
    if (!employeeId) continue;
    const fullName = textOf(entry.FullName) || textOf(entry.Fullname);

    let emp = byEmp.get(employeeId);
    if (!emp) {
      emp = { employeeId, fullName, documents: [] };
      byEmp.set(employeeId, emp);
    }

    for (const group of asArray(entry.Worker_Documents_group)) {
      const referenceId = textOf(group.referenceID) || textOf(group.ReferenceID);
      const filename = textOf(group.Filename);
      const docCategory =
        descriptorOf(group.DocCategory) ||
        idOfType(group.DocCategory, 'Document_Category__Workday_Owned__ID') ||
        'Education';

      if (!referenceId && !filename) continue;

      emp.documents.push({
        referenceId,
        filename: filename || 'document.pdf',
        docCategory,
      });
    }
  }

  return [...byEmp.values()].filter((e) => e.documents.length > 0);
}

/**
 * Parse Staffing Get_Workers SOAP response for education worker documents.
 *
 * Match strategy (requirements):
 *   - Worker_ID / Employee_ID
 *   - Worker_Document_Reference WID vs list referenceID
 *   - Category EDUCATION
 *
 * @param {string} soapXml
 * @param {{ referenceIds?: Set<string>|string[], educationOnly?: boolean }} [options]
 * @returns {{
 *   workerId: string,
 *   documents: Array<{
 *     wid: string,
 *     fileId: string,
 *     filename: string,
 *     categoryId: string,
 *     categoryDescriptor: string,
 *     fileBase64: string
 *   }>
 * }}
 */
export function parseWorkerDocumentsSoap(soapXml, options = {}) {
  const educationOnly = options.educationOnly !== false;
  const referenceIds = options.referenceIds
    ? new Set(
        [...options.referenceIds].map(String).filter(Boolean)
      )
    : null;

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
      const categoryId =
        idOfType(catRef, 'Document_Category__Workday_Owned__ID') ||
        idOfType(catRef, 'Document_Category_ID');
      const categoryDescriptor = descriptorOf(catRef) || categoryId;
      const filename = textOf(detail?.Filename);
      const fileBase64 = textOf(detail?.File);

      if (!fileBase64) continue;

      const isEducation =
        String(categoryId || '').toUpperCase() === 'EDUCATION' ||
        /education/i.test(String(categoryDescriptor || ''));

      if (educationOnly && !isEducation) continue;
      if (referenceIds && referenceIds.size > 0 && wid && !referenceIds.has(wid)) {
        continue;
      }

      documents.push({
        wid,
        fileId,
        filename: filename || 'document.pdf',
        categoryId: categoryId || 'EDUCATION',
        categoryDescriptor: categoryDescriptor || 'Education',
        fileBase64,
      });
    }
  }

  return { workerId, documents };
}

function asArray(value) {
  if (value === undefined || value === null) return [];
  return Array.isArray(value) ? value : [value];
}

function textOf(node) {
  if (node === undefined || node === null) return '';
  if (typeof node === 'string' || typeof node === 'number') return String(node).trim();
  if (typeof node === 'object') {
    if (node['#text'] !== undefined) return String(node['#text']).trim();
    // sometimes ID nodes are objects without text if only attributes
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
