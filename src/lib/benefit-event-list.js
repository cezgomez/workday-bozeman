import { XMLParser } from 'fast-xml-parser';

const listParser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  textNodeName: '#text',
  isArray: (name) =>
    [
      'Report_Entry',
      'Review_Documents_group',
      'ID',
      'wd:Report_Entry',
      'wd:Review_Documents_group',
      'wd:ID',
    ].includes(name),
  removeNSPrefix: true,
});

/**
 * Parse Benefit Event list (CR_Export_Benefit_Event_-_Copy) — metadata, no base64.
 *
 * @returns {Array<{
 *   employeeId: string,
 *   fullName: string,
 *   workdayId: string,
 *   documents: Array<{ wdwid: string, bpType: string, comment: string, eventDescription: string }>
 * }>}
 */
export function parseBenefitEventListXml(xmlString) {
  const parsed = listParser.parse(xmlString);
  const reportData = parsed?.Report_Data ?? parsed;
  const entries = asArray(reportData?.Report_Entry);
  /** @type {Map<string, object>} */
  const byEmp = new Map();

  for (const entry of entries) {
    const employeeId = textOf(entry.EmployeeID);
    if (!employeeId) continue;
    const fullName = textOf(entry.Fullname) || textOf(entry.FullName);
    const workdayId = textOf(entry.workdayID) || textOf(entry.WorkdayID);

    let emp = byEmp.get(employeeId);
    if (!emp) {
      emp = { employeeId, fullName, workdayId, documents: [] };
      byEmp.set(employeeId, emp);
    } else if (!emp.workdayId && workdayId) {
      emp.workdayId = workdayId;
    }

    for (const group of asArray(entry.Review_Documents_group)) {
      const wdwid = textOf(group.WDWID);
      const bpType = descriptorOf(group.BPType);
      const comment = textOf(group.Comment);
      const eventDescription = textOf(group.EventDescription);
      // List report may not include Attachment; WDWWID links to detail Base64
      if (!wdwid && !bpType) continue;
      emp.documents.push({
        wdwid,
        bpType,
        comment,
        eventDescription,
      });
    }
  }

  return [...byEmp.values()].filter((e) => e.documents.length > 0 && e.workdayId);
}

/**
 * Parse Benefit Event detail (CR_Export_Benefit_Event?Worker!WID=) with Base64.
 *
 * @returns {Map<string, { attachmentDescriptor: string, base64: string, employeeId: string }>}
 *   keyed by WDWID / Attachment WID
 */
export function parseBenefitEventDetailXml(xmlString) {
  const parsed = listParser.parse(xmlString);
  const reportData = parsed?.Report_Data ?? parsed;
  const entries = asArray(reportData?.Report_Entry);
  /** @type {Map<string, object>} */
  const byWid = new Map();

  for (const entry of entries) {
    const employeeId = textOf(entry.EmployeeID);
    for (const group of asArray(entry.Review_Documents_group)) {
      const wdwid = textOf(group.WDWID);
      const attachmentWid = idOfType(group.Attachment, 'WID') || wdwid;
      const attachmentDescriptor =
        descriptorOf(group.Attachment) ||
        textOf(group.EventDescription) ||
        textOf(group.Comment) ||
        'attachment.pdf';
      const base64 = textOf(group.Base64);
      if (!base64) continue;
      const key = attachmentWid || wdwid;
      if (!key) continue;
      byWid.set(key, {
        attachmentDescriptor,
        base64,
        employeeId,
        wdwid,
      });
    }
  }

  return byWid;
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
