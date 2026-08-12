import { XMLParser } from 'fast-xml-parser';
import { sanitizeFileNamePart } from './naming.js';

/**
 * Certification RaaS parsing and selection.
 *
 * Requirements (API Certification):
 *   - Report 1 (list): CR_Export_Certification_-_Copy → EmployeeID + workdayID + events
 *   - Report 2 (detail): CR_Export_Certification?Worker!WID=… → events + base64
 *   - Per Certifications_from_Action_Event Descriptor, keep the event with the
 *     most recent `completed` timestamp and upload ALL Attachments on that event
 *   - Path: Certification/100_{EmployeeID}_{CertDescriptorNoSpaces}_{AttachmentNoSpaces}
 *
 * Example (emp 46929, BLS): most recent completed has 3 files
 *   foggnbls09012023.pdf, BLS 2023.pdf, bls 2025.pdf
 */

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  textNodeName: '#text',
  isArray: (name) =>
    [
      'Report_Entry',
      'Worker_Events_-_Completed_group',
      'Certifications_from_Action_Event',
      'Attachments',
      'Attachment',
      'ID',
      'CF_All_Certification_Attachments_group',
      'wd:Report_Entry',
      'wd:Worker_Events_-_Completed_group',
      'wd:Certifications_from_Action_Event',
      'wd:Attachments',
      'wd:Attachment',
      'wd:ID',
      'wd:CF_All_Certification_Attachments_group',
    ].includes(name),
  removeNSPrefix: true,
});

/**
 * Parse WIDs-only / list report into unique employees (with workdayID).
 *
 * @returns {Array<{
 *   employeeId: string,
 *   fullName: string,
 *   workdayId: string,
 *   eventCount: number,
 *   certDescriptors: string[]
 * }>}
 */
export function parseCertificationListXml(xmlString) {
  const parsed = parser.parse(xmlString);
  const reportData = parsed?.Report_Data ?? parsed;
  const entries = asArray(reportData?.Report_Entry);

  /** @type {Map<string, object>} */
  const byEmp = new Map();

  for (const entry of entries) {
    const employeeId = textOf(entry.EmployeeID);
    if (!employeeId) continue;
    const fullName = textOf(entry.Fullname) || textOf(entry.FullName);
    const workdayId = textOf(entry.workdayID) || textOf(entry.workdayId);

    let emp = byEmp.get(employeeId);
    if (!emp) {
      emp = {
        employeeId,
        fullName,
        workdayId,
        eventCount: 0,
        certSet: new Set(),
      };
      byEmp.set(employeeId, emp);
    } else if (!emp.workdayId && workdayId) {
      emp.workdayId = workdayId;
    }

    const events = asArray(entry['Worker_Events_-_Completed_group']);
    emp.eventCount += events.length;
    for (const ev of events) {
      for (const cert of asArray(ev.Certifications_from_Action_Event)) {
        const desc = descriptorOf(cert);
        if (desc) emp.certSet.add(desc);
      }
    }
  }

  const result = [];
  for (const emp of byEmp.values()) {
    if (!emp.workdayId) continue;
    result.push({
      employeeId: emp.employeeId,
      fullName: emp.fullName,
      workdayId: emp.workdayId,
      eventCount: emp.eventCount,
      certDescriptors: [...emp.certSet],
    });
  }
  return result;
}

/**
 * Parse detail report and select files.
 *
 * Selection rules:
 *   1. Each Certifications_from_Action_Event is identified by its **WID**
 *      (not just the display Descriptor). Two certs can share the same name
 *      (e.g. "Continuing Education Units - Continuing Education") but are
 *      different instances with different attachments — keep both.
 *   2. For each cert WID, keep the event with the most recent `completed`
 *      among events that reference that cert WID.
 *   3. Upload every Attachment on that winning event (with base64 from
 *      CF_All_Certification_Attachments_group).
 *
 * Emp 36521 example — Continuing Education Units (2 cert WIDs → 2 files):
 *   - Advanced EFM Certificate.pdf
 *   - Anderson Intermediate Fetal Monitoring Course.pdf
 *
 * @returns {{
 *   employeeId: string,
 *   fullName: string,
 *   workdayId: string,
 *   files: Array<{
 *     certDescriptor: string,
 *     certWid: string,
 *     completed: string,
 *     attachmentDescriptor: string,
 *     attachmentWid: string,
 *     fileId: string,
 *     base64: string
 *   }>,
 *   certsWithNoContent: Array<{ certDescriptor: string, certWid: string, completed: string, missing: number }>
 * }}
 */
export function parseCertificationDetailAndSelect(xmlString) {
  const parsed = parser.parse(xmlString);
  const reportData = parsed?.Report_Data ?? parsed;
  const entries = asArray(reportData?.Report_Entry);
  const entry = entries[0] || {};

  const employeeId = textOf(entry.EmployeeID);
  const fullName = textOf(entry.Fullname) || textOf(entry.FullName);
  const workdayId = textOf(entry.workdayID) || textOf(entry.workdayId);

  const contentByWid = new Map();
  const contentByFileId = new Map();
  const contentByName = new Map();

  for (const group of asArray(entry.CF_All_Certification_Attachments_group)) {
    const attNode = firstOf(group.Attachment);
    const attachmentDescriptor =
      descriptorOf(attNode) || textOf(group.fileName) || 'document.pdf';
    const attachmentWid = idOfType(attNode, 'WID');
    const fileId = idOfType(attNode, 'File_ID');
    const base64 =
      textOf(group.attachmentContent) ||
      textOf(group.Attachment_Content) ||
      textOf(group.Attachment_Base64) ||
      textOf(group.File_Content) ||
      '';
    if (!base64) continue;

    const rec = {
      attachmentDescriptor,
      attachmentWid,
      fileId,
      base64,
    };
    if (attachmentWid) contentByWid.set(attachmentWid, rec);
    if (fileId) contentByFileId.set(fileId, rec);
    const nameKey = normalizeNameKey(attachmentDescriptor);
    if (nameKey && !contentByName.has(nameKey)) {
      contentByName.set(nameKey, rec);
    }
  }

  /**
   * Key by certification instance WID (fallback: descriptor when WID missing).
   * Same display name + different WIDs stay separate.
   * @type {Map<string, { certDescriptor: string, certWid: string, completed: string, attachments: object[] }>}
   */
  const bestByCertInstance = new Map();

  for (const ev of asArray(entry['Worker_Events_-_Completed_group'])) {
    const completed = textOf(ev.completed);
    const certNodes = asArray(ev.Certifications_from_Action_Event);
    const attachments = asArray(ev.Attachments)
      .map((a) => ({
        attachmentDescriptor: descriptorOf(a) || 'document.pdf',
        attachmentWid: idOfType(a, 'WID'),
        fileId: idOfType(a, 'File_ID'),
      }))
      .filter((a) => a.attachmentDescriptor || a.attachmentWid);

    if (certNodes.length === 0) continue;

    for (const certNode of certNodes) {
      const certDescriptor = descriptorOf(certNode);
      if (!certDescriptor) continue;
      const certWid = idOfType(certNode, 'WID');
      // Unique instance key: prefer WID so same-named certs are not collapsed
      const instanceKey = certWid || `desc:${certDescriptor}`;

      const prev = bestByCertInstance.get(instanceKey);
      if (!prev || isCompletedNewer(completed, prev.completed)) {
        bestByCertInstance.set(instanceKey, {
          certDescriptor,
          certWid,
          completed,
          attachments: attachments.slice(),
        });
      }
    }
  }

  const files = [];
  const certsWithNoContent = [];
  /** Avoid uploading the same attachment binary twice under the same cert instance */
  const seenPair = new Set();

  for (const info of bestByCertInstance.values()) {
    const { certDescriptor, certWid, completed, attachments } = info;

    if (!attachments.length) {
      certsWithNoContent.push({
        certDescriptor,
        certWid,
        completed,
        missing: 0,
      });
      continue;
    }

    let missing = 0;
    for (const att of attachments) {
      const hit =
        (att.attachmentWid && contentByWid.get(att.attachmentWid)) ||
        (att.fileId && contentByFileId.get(att.fileId)) ||
        contentByName.get(normalizeNameKey(att.attachmentDescriptor)) ||
        null;

      if (!hit?.base64) {
        missing += 1;
        continue;
      }

      const dedupeKey = `${certWid || certDescriptor}::${
        hit.attachmentWid || hit.fileId || hit.attachmentDescriptor
      }`;
      if (seenPair.has(dedupeKey)) continue;
      seenPair.add(dedupeKey);

      files.push({
        certDescriptor,
        certWid,
        completed,
        attachmentDescriptor:
          hit.attachmentDescriptor || att.attachmentDescriptor,
        attachmentWid: hit.attachmentWid || att.attachmentWid,
        fileId: hit.fileId || att.fileId,
        base64: hit.base64,
      });
    }

    if (missing > 0) {
      certsWithNoContent.push({
        certDescriptor,
        certWid,
        completed,
        missing,
      });
    }
  }

  return {
    employeeId,
    fullName,
    workdayId,
    files,
    certsWithNoContent,
    certCount: bestByCertInstance.size,
  };
}

/**
 * Build relative path:
 *   Certification/100_{EmployeeID}_{CertDescriptorNoSpaces}_{AttachmentNoSpaces}
 */
export function buildCertificationPath({
  employeeId,
  certDescriptor,
  attachmentDescriptor,
}) {
  const certPart = sanitizeFileNamePart(certDescriptor || 'Certification');
  const attachRaw =
    attachmentDescriptor && String(attachmentDescriptor).trim()
      ? attachmentDescriptor
      : 'document.pdf';
  const match = String(attachRaw).match(/^(.*?)(\.[A-Za-z0-9]{1,8})$/);
  const base = match ? match[1] : attachRaw;
  const ext = match ? match[2] : '';
  const attachPart = sanitizeFileNamePart(base) + ext;
  return `Certification/100_${employeeId}_${certPart}_${attachPart}`;
}

/**
 * Compare Workday completed timestamps (ISO-like with offset).
 * Returns true if a is strictly newer than b.
 */
export function isCompletedNewer(a, b) {
  const ta = Date.parse(a);
  const tb = Date.parse(b);
  if (!Number.isNaN(ta) && !Number.isNaN(tb)) return ta > tb;
  // Fallback: lexical compare on ISO strings often works with offsets stripped
  return String(a || '') > String(b || '');
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

function firstOf(value) {
  const arr = asArray(value);
  return arr[0] ?? null;
}

function textOf(node) {
  if (node === undefined || node === null) return '';
  if (typeof node === 'string' || typeof node === 'number') {
    return String(node).trim();
  }
  if (typeof node === 'object' && node['#text'] !== undefined) {
    return String(node['#text']).trim();
  }
  return '';
}

function descriptorOf(node) {
  if (!node) return '';
  if (typeof node === 'string') return node.trim();
  return String(
    node['@_Descriptor'] || node['@_wd:Descriptor'] || textOf(node) || ''
  ).trim();
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
