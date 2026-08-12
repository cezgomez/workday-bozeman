import { XMLParser } from 'fast-xml-parser';

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  // Preserve text when mixed content exists
  textNodeName: '#text',
  // Workday wraps many single-child arrays; force array for repeating groups
  isArray: (name) =>
    ['Report_Entry', 'Review_Documents_group', 'wd:Report_Entry', 'wd:Review_Documents_group'].includes(
      name
    ),
  removeNSPrefix: true,
});

/**
 * Parse Workday Review Document RaaS XML into a flat list of attachment records.
 *
 * @returns {Array<{
 *   employeeId: string,
 *   fullName: string,
 *   workdayId: string,
 *   docCategory: string,
 *   documentDescriptor: string,
 *   attachmentDescriptor: string,
 *   attachmentBase64: string|null
 * }>}
 */
export function parseReviewDocumentXml(xmlString) {
  const parsed = parser.parse(xmlString);
  const reportData = parsed?.Report_Data ?? parsed?.['wd:Report_Data'] ?? parsed;
  const entries = asArray(reportData?.Report_Entry ?? reportData?.['wd:Report_Entry']);

  const records = [];

  for (const entry of entries) {
    const employeeId = textOf(entry.EmployeeID);
    const fullName = textOf(entry.Fullname);
    const workdayId = textOf(entry.workdayID);

    const groups = asArray(entry.Review_Documents_group);
    for (const group of groups) {
      const docCategory = descriptorOf(group.DocCategory);
      // Document may appear once (object) or theoretically more than once
      const documentNode = firstOf(group.Document);
      const documentDescriptor = descriptorOf(documentNode);
      const attachmentNode = firstOf(group.Attachment);
      const attachmentDescriptor = descriptorOf(attachmentNode);
      const attachmentBase64 = textOf(group.Attachment_Base64) || null;

      if (!documentDescriptor && !attachmentDescriptor) continue;

      records.push({
        employeeId,
        fullName,
        workdayId,
        docCategory,
        documentDescriptor,
        attachmentDescriptor,
        attachmentBase64,
      });
    }
  }

  return records;
}

function asArray(value) {
  if (value === undefined || value === null) return [];
  return Array.isArray(value) ? value : [value];
}

function firstOf(value) {
  const arr = asArray(value);
  return arr[0] ?? null;
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
  if (!node || typeof node !== 'object') return textOf(node);
  return (
    node['@_Descriptor'] ||
    node['@_wd:Descriptor'] ||
    node['Descriptor'] ||
    textOf(node)
  );
}
