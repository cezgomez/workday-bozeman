import { XMLParser } from 'fast-xml-parser';

/**
 * Allowed Workplace Test Type directories (requirements lines 604–617).
 * Matching is case-insensitive; punctuation normalized for flexibility.
 */
export const WORKPLACE_TEST_DIRECTORIES = [
  'Fit test, filtering facepiece respirator',
  'Fit test, full facepiece respirator',
  'Fit test, half facepiece respirator',
  'Hepatitis B Titer Test',
  'Measles Titer Test',
  'Mumps Titer Test',
  'Respirator Medical Evaluation',
  'Respirator Medical Evaluation including Full Facepiece',
  'Rubella Titer Test',
  'Tuberculosis Test - QuantiFERON-TB Gold',
  'Respirator 1870+',
  'Hepatitis C AB',
  'Varicella Titer Test',
  'Tuberculosis Test - 2 Step Tuberculin PPD',
];

const listParser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  textNodeName: '#text',
  isArray: (name) =>
    [
      'Report_Entry',
      'WorkplaceTest',
      'WPAttachment',
      'Base64',
      'ID',
      'wd:Report_Entry',
      'wd:WorkplaceTest',
      'wd:WPAttachment',
      'wd:Base64',
      'wd:ID',
    ].includes(name),
  removeNSPrefix: true,
});

const detailParser = new XMLParser({
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
 * Parse Report 1 (CR_Export_Workplace_Test) metadata list.
 *
 * @returns {Array<{
 *   employeeId: string,
 *   fullName: string,
 *   workdayId: string,
 *   tests: Array<{
 *     testWid: string,
 *     testType: string,
 *     attachmentWid: string,
 *     attachmentFileId: string,
 *     attachmentDescriptor: string
 *   }>
 * }>}
 */
export function parseWorkplaceTestListXml(xmlString) {
  const parsed = listParser.parse(xmlString);
  const reportData = parsed?.Report_Data ?? parsed;
  const entries = asArray(reportData?.Report_Entry);
  const employees = [];

  for (const entry of entries) {
    const employeeId = textOf(entry.EmployeeID);
    if (!employeeId) continue;
    const fullName = textOf(entry.Name) || textOf(entry.Fullname) || textOf(entry.FullName);
    const workdayId = textOf(entry.workdayID) || textOf(entry.WorkdayID);
    const tests = [];

    for (const wt of asArray(entry.WorkplaceTest)) {
      const testWid = textOf(wt.WPTestWID);
      const testType =
        descriptorOf(wt.WPTestType) ||
        idOfType(wt.WPTestType, 'Workplace_Test_Type_ID');
      if (!testType) continue;

      // A WorkplaceTest can have multiple WPAttachment / Base64 nodes
      const attachments = asArray(wt.WPAttachment);
      const base64Refs = asArray(wt.Base64);
      const attachNodes = attachments.length > 0 ? attachments : base64Refs;

      // SubFilter: WPAttachment is not empty
      if (attachNodes.length === 0) continue;

      for (const attach of attachNodes) {
        const attachmentWid = idOfType(attach, 'WID');
        const attachmentFileId = idOfType(attach, 'File_ID');
        const attachmentDescriptor =
          descriptorOf(attach) || 'attachment.pdf';

        if (!attachmentWid && attachmentDescriptor === 'attachment.pdf') continue;

        tests.push({
          testWid,
          testType,
          attachmentWid,
          attachmentFileId,
          attachmentDescriptor,
        });
      }
    }

    if (tests.length === 0) continue;
    employees.push({ employeeId, fullName, workdayId, tests });
  }

  return employees;
}

/**
 * Parse Report 2 (CR_Export_Workplace_Test_Copy) — attachment base64 content.
 *
 * @returns {Map<string, { attachmentDescriptor: string, base64: string }>}
 *   keyed by WDWID / Attachment WID
 */
export function parseWorkplaceTestDetailXml(xmlString) {
  const parsed = detailParser.parse(xmlString);
  const reportData = parsed?.Report_Data ?? parsed;
  const entries = asArray(reportData?.Report_Entry);
  /** @type {Map<string, { attachmentDescriptor: string, base64: string, employeeId: string }>} */
  const byWid = new Map();

  for (const entry of entries) {
    const employeeId = textOf(entry.EmployeeID);
    for (const group of asArray(entry.Review_Documents_group)) {
      const wdwid = textOf(group.WDWID);
      const attachmentWid = idOfType(group.Attachment, 'WID') || wdwid;
      const attachmentDescriptor =
        descriptorOf(group.Attachment) || 'attachment.pdf';
      const base64 = textOf(group.Base64);
      if (!base64) continue;
      const key = attachmentWid || wdwid;
      if (!key) continue;
      byWid.set(key, { attachmentDescriptor, base64, employeeId });
    }
  }

  return byWid;
}

/**
 * Select work items: for each allowed test-type directory, first N employees
 * that have that type (and a WPAttachment).
 *
 * @returns {{
 *   byDirectory: Map<string, Array<object>>,
 *   workItems: Array<object>,
 *   workersNeeded: Map<string, { employeeId: string, workdayId: string, fullName: string }>
 * }}
 */
export function selectWorkplaceTestWork({
  employees,
  maxEmployeesPerDirectory = 20,
  allowedTypes = WORKPLACE_TEST_DIRECTORIES,
}) {
  const allowedNorm = new Map(
    allowedTypes.map((t) => [normalizeTypeKey(t), t])
  );

  /** @type {Map<string, string[]>} employeeIds selected per directory */
  const selectedEmps = new Map();
  /** @type {Map<string, Array<object>>} first-touch items per directory (for reporting) */
  const byDirectory = new Map();
  for (const t of allowedTypes) {
    selectedEmps.set(t, []);
    byDirectory.set(t, []);
  }

  /** @type {Array<object>} */
  const workItems = [];
  /** @type {Map<string, object>} */
  const workersNeeded = new Map();
  const seenItem = new Set();

  for (const emp of employees) {
    for (const test of emp.tests) {
      const canon = allowedNorm.get(normalizeTypeKey(test.testType));
      if (!canon) continue;

      const selected = selectedEmps.get(canon);
      const already = selected.includes(emp.employeeId);
      if (!already) {
        if (selected.length >= maxEmployeesPerDirectory) continue;
        selected.push(emp.employeeId);
      }

      const itemKey = `${emp.employeeId}::${test.attachmentWid || test.testWid}::${canon}`;
      if (seenItem.has(itemKey)) continue;
      seenItem.add(itemKey);

      const item = {
        employeeId: emp.employeeId,
        fullName: emp.fullName,
        workdayId: emp.workdayId,
        testType: canon,
        originalTestType: test.testType,
        testWid: test.testWid,
        attachmentWid: test.attachmentWid,
        attachmentFileId: test.attachmentFileId,
        attachmentDescriptor: test.attachmentDescriptor,
      };

      if (!already) byDirectory.get(canon).push(item);
      workItems.push(item);

      if (emp.workdayId) {
        workersNeeded.set(emp.workdayId, {
          employeeId: emp.employeeId,
          workdayId: emp.workdayId,
          fullName: emp.fullName,
        });
      }
    }
  }

  return { byDirectory, workItems, workersNeeded };
}

export function normalizeTypeKey(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/&amp;/g, '&')
    .replace(/[^a-z0-9+]+/g, ' ')
    .replace(/\s+/g, ' ')
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
  // sometimes single ID object
  if (node['@_type'] === typeName) return textOf(node);
  return '';
}
