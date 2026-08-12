import { XMLParser } from 'fast-xml-parser';

/**
 * Parse a Generated Document ID style RaaS list (JSON or XML) into:
 *   [{ employeeId, fullName, workdayId, documents: [{ attachmentDescriptor, documentId, documentType, docCategory }] }]
 *
 * Supports:
 *   - Review_Documents_group + Attachment + DocumentID (job-description, pay-increase, etc.)
 *   - GeneratedOfferAttachments + File + Document_ID (job-offer)
 */
export function parseGeneratedDocumentList(body, { defaultAttachmentName = 'Document.pdf' } = {}) {
  const trimmed = body.trim();
  if (!trimmed) return [];

  if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
    const json = JSON.parse(trimmed);
    const entries = Array.isArray(json) ? json : json.Report_Entry || [];
    const arr = Array.isArray(entries) ? entries : [entries];
    return arr
      .map((e) => normalizeEntry(e, defaultAttachmentName))
      .filter((e) => e.employeeId);
  }

  return parseXmlList(trimmed, defaultAttachmentName);
}

function normalizeEntry(entry, defaultAttachmentName) {
  const employeeId = extractEmployeeId(entry);
  const fullName = extractFullName(entry);
  const workdayId = entry.workdayID ?? entry.WorkdayID ?? entry.workdayId;
  const groups = [
    ...asArray(entry.Review_Documents_group),
    ...asArray(entry.GeneratedOfferAttachments),
    ...asArray(entry.generatedOfferAttachments),
  ];
  const documents = [];

  for (const g of groups) {
    const fileOrAttachment = g.Attachment ?? g.File ?? g.file ?? g.attachment;
    const documentId =
      g.DocumentID ||
      g.Document_ID ||
      g.documentId ||
      g.document_id ||
      extractDocumentIdFromAttachment(fileOrAttachment) ||
      '';
    const attachmentDescriptor =
      descriptorOf(fileOrAttachment) ||
      (typeof fileOrAttachment === 'string' ? fileOrAttachment : '') ||
      defaultAttachmentName;
    const documentType = descriptorOf(g.Document) || '';
    const docCategory =
      descriptorOf(g.DocCategory) ||
      descriptorOf(g.DocumentCategory) ||
      '';

    if (documentId) {
      documents.push({
        documentId: String(documentId).trim(),
        attachmentDescriptor: String(attachmentDescriptor).trim(),
        documentType: String(documentType).trim(),
        docCategory: String(docCategory).trim(),
      });
    }
  }

  return { employeeId, fullName, workdayId, documents };
}

function extractEmployeeId(entry) {
  // Standard reports
  if (entry.EmployeeID != null) return String(entry.EmployeeID).trim();
  if (entry.employeeId != null) return String(entry.employeeId).trim();

  // Job offer: Worker_group.EmployeeID
  const workerGroup = entry.Worker_group || entry.WorkerGroup;
  if (workerGroup?.EmployeeID != null) return String(workerGroup.EmployeeID).trim();
  if (Array.isArray(workerGroup) && workerGroup[0]?.EmployeeID != null) {
    return String(workerGroup[0].EmployeeID).trim();
  }

  // Job offer: Fullname.ID type Employee_ID
  const fullname = entry.Fullname || entry.fullname;
  const ids = asArray(fullname?.ID || fullname?.id);
  for (const id of ids) {
    if (typeof id === 'object') {
      const type = id['@_type'] || id['@_wd:type'] || id.type;
      if (String(type) === 'Employee_ID') {
        const val = id['#text'] ?? id;
        if (val != null && typeof val !== 'object') return String(val).trim();
      }
    } else if (typeof id === 'string' || typeof id === 'number') {
      // JSON may flatten differently
    }
  }

  // JSON shape sometimes: Fullname: { ID: [ { type: Employee_ID, ...} ] } without @_
  // Also plain string EmployeeID nested under Fullname as property
  if (fullname && typeof fullname === 'object' && fullname.Employee_ID) {
    return String(fullname.Employee_ID).trim();
  }

  return '';
}

function extractFullName(entry) {
  const fullname = entry.Fullname ?? entry.fullName;
  if (fullname == null) return undefined;
  if (typeof fullname === 'string') return fullname;
  return descriptorOf(fullname) || fullname['#text'] || undefined;
}

function extractDocumentIdFromAttachment(att) {
  if (!att || typeof att !== 'object') return '';
  const ids = asArray(att.ID || att.id);
  for (const id of ids) {
    if (typeof id === 'object') {
      const type = id['@_type'] || id['@_wd:type'] || id.type;
      if (String(type).includes('Document_ID')) {
        const val = id['#text'] ?? id;
        if (val != null && typeof val !== 'object') return String(val);
      }
    }
  }
  return '';
}

function descriptorOf(node) {
  if (!node || typeof node !== 'object') return typeof node === 'string' ? node : '';
  return node['@_Descriptor'] || node['@_wd:Descriptor'] || node.Descriptor || '';
}

function asArray(value) {
  if (value === undefined || value === null) return [];
  return Array.isArray(value) ? value : [value];
}

function parseXmlList(xml, defaultAttachmentName) {
  const parser = new XMLParser({
    ignoreAttributes: false,
    attributeNamePrefix: '@_',
    removeNSPrefix: true,
    isArray: (name) =>
      [
        'Report_Entry',
        'Review_Documents_group',
        'GeneratedOfferAttachments',
        'ID',
      ].includes(name),
  });
  const parsed = parser.parse(xml);
  const reportData = parsed?.Report_Data ?? parsed;
  const entries = asArray(reportData?.Report_Entry);
  return entries
    .map((e) => normalizeEntry(e, defaultAttachmentName))
    .filter((e) => e.employeeId);
}
