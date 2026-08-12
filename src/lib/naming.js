import path from 'node:path';

/**
 * Convention:
 *   {Document Descriptor spaces→_}/100_{EmployeeId}_{DocumentNoSpaces}_{AttachmentNoSpaces}
 *
 * Example:
 *   Hazardous_Drug_Handling_Acknowledgement_of_Risk/100_49494_HazardousDrugHandlingAcknowledgementofRisk_HazardousDrugHandlingAcknowledgementOfRisk.pdf
 *
 * - Directory: Document wd:Descriptor, spaces replaced with underscores
 * - Filename parts: spaces and underscores removed from Document + Attachment descriptors
 *   (structural separators between 100 / employeeId / prefix / attach stay as `_`)
 */
export function buildOutputPath({ documentDescriptor, employeeId, attachmentDescriptor }) {
  const dirName = toDirectoryName(documentDescriptor);
  const fileName = toFileName(employeeId, documentDescriptor, attachmentDescriptor);
  return path.join(dirName, fileName);
}

/** Document descriptor: spaces → underscores */
export function toDirectoryName(documentDescriptor) {
  const decoded = decodeXmlEntities(documentDescriptor || 'Unknown_Document');
  return decoded
    .trim()
    .replace(/\s+/g, '_')
    .replace(/[<>:"/\\|?*]/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_|_$/g, '');
}

/**
 * 100_{EmployeeId}_{DocumentNoSpaces}_{AttachmentNoSpaces}
 * Spaces and underscores from the original descriptors are removed in file name parts.
 */
export function toFileName(employeeId, documentDescriptor, attachmentDescriptor) {
  const docPart = sanitizeFileNamePart(documentDescriptor || 'Document');
  const attachRaw =
    attachmentDescriptor && String(attachmentDescriptor).trim()
      ? attachmentDescriptor
      : `${documentDescriptor || 'attachment'}.pdf`;

  // Split extension so we keep a single trailing .pdf (or other ext)
  const { base, ext } = splitExtension(attachRaw);
  const attachPart = sanitizeFileNamePart(base) + ext;

  return `100_${employeeId}_${docPart}_${attachPart}`;
}

/**
 * Sanitize a file-name segment from an original Workday descriptor/filename:
 * remove whitespace and underscores (and illegal path chars).
 * Extension is handled separately by callers.
 */
export function sanitizeFileNamePart(value) {
  return decodeXmlEntities(value || '')
    .trim()
    .replace(/\s+/g, '')
    .replace(/_/g, '')
    .replace(/[<>:"/\\|?*]/g, '');
}

/** @deprecated use sanitizeFileNamePart — strips spaces and underscores */
export function removeSpaces(value) {
  return sanitizeFileNamePart(value);
}

function splitExtension(filename) {
  const decoded = decodeXmlEntities(filename || '').trim();
  const match = decoded.match(/^(.*?)(\.[A-Za-z0-9]{1,8})$/);
  if (match) {
    return { base: match[1], ext: match[2] };
  }
  return { base: decoded, ext: '' };
}

/**
 * Job Description convention (requirements lines 103–108):
 *   Job_Description/100_{EmployeeId}_JobDescription_{AttachmentNoSpaces}
 */
export function buildJobDescriptionPath({ employeeId, attachmentDescriptor }) {
  return buildGeneratedDocumentPath({
    directoryName: 'Job_Description',
    filePrefix: 'JobDescription',
    employeeId,
    attachmentDescriptor,
  });
}

/**
 * Market Adjustment convention:
 *   Market_Adjustment/100_{EmployeeId}_MarketAdjustment_{AttachmentNoSpaces}
 */
export function buildMarketAdjustmentPath({ employeeId, attachmentDescriptor }) {
  return buildGeneratedDocumentPath({
    directoryName: 'Market_Adjustment',
    filePrefix: 'MarketAdjustment',
    employeeId,
    attachmentDescriptor,
  });
}

/**
 * Pay Increase convention (requirements lines 178–183):
 *   Pay_Increase/100_{EmployeeId}_PayIncrease_{AttachmentNoSpaces}
 *
 * Example:
 *   Pay_Increase/100_41197_PayIncrease_2025PayIncrease2025-04-18.pdf
 */
export function buildPayIncreasePath({ employeeId, attachmentDescriptor }) {
  return buildGeneratedDocumentPath({
    directoryName: 'Pay_Increase',
    filePrefix: 'PayIncrease',
    employeeId,
    attachmentDescriptor,
  });
}

/**
 * Generic generated-doc path:
 *   {directoryName}/100_{EmployeeId}_{filePrefix}_{AttachmentNoSpaces}
 */
export function buildGeneratedDocumentPath({
  directoryName,
  filePrefix,
  employeeId,
  attachmentDescriptor,
}) {
  const attachRaw =
    attachmentDescriptor && String(attachmentDescriptor).trim()
      ? attachmentDescriptor
      : `${filePrefix}.pdf`;
  const { base, ext } = splitExtension(attachRaw);
  const attachPart = sanitizeFileNamePart(base) + (ext || '.pdf');
  const fileName = `100_${employeeId}_${filePrefix}_${attachPart}`;
  return path.join(directoryName, fileName);
}

function decodeXmlEntities(value) {
  return String(value)
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'");
}
