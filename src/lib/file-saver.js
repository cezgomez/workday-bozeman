import fs from 'node:fs/promises';
import path from 'node:path';
import {
  buildGeneratedDocumentPath,
  buildJobDescriptionPath,
  buildMarketAdjustmentPath,
  buildOutputPath,
} from './naming.js';

/**
 * Save decoded attachment under the FTP destination root (mock/ for now).
 * Returns absolute path written, or null if skipped (no base64).
 */
export async function saveAttachment(destinationRoot, record) {
  if (!record.attachmentBase64) {
    return { skipped: true, reason: 'no Attachment_Base64' };
  }

  const relativePath = buildOutputPath({
    documentDescriptor: record.documentDescriptor,
    employeeId: record.employeeId,
    attachmentDescriptor: record.attachmentDescriptor || `${record.documentDescriptor}.pdf`,
  });

  const buffer = Buffer.from(record.attachmentBase64, 'base64');
  return writeBuffer(destinationRoot, relativePath, buffer);
}

/**
 * Save a raw buffer (e.g. blobitory PDF) using review-document naming.
 */
export async function saveBuffer(destinationRoot, relativePath, buffer) {
  return writeBuffer(destinationRoot, relativePath, buffer);
}

/**
 * Save job-description PDF using Job_Description/100_{emp}_JobDescription_{attach} naming.
 */
export async function saveJobDescriptionFile(destinationRoot, { employeeId, attachmentDescriptor, buffer }) {
  const relativePath = buildJobDescriptionPath({ employeeId, attachmentDescriptor });
  return writeBuffer(destinationRoot, relativePath, buffer);
}

/**
 * Save market-adjustment PDF:
 *   Market_Adjustment/100_{emp}_MarketAdjustment_{attach}
 */
export async function saveMarketAdjustmentFile(destinationRoot, { employeeId, attachmentDescriptor, buffer }) {
  const relativePath = buildMarketAdjustmentPath({ employeeId, attachmentDescriptor });
  return writeBuffer(destinationRoot, relativePath, buffer);
}

/**
 * Save any generated-document export (blobitory) with configurable directory/prefix.
 */
export async function saveGeneratedDocumentFile(
  destinationRoot,
  { directoryName, filePrefix, employeeId, attachmentDescriptor, buffer }
) {
  const relativePath = buildGeneratedDocumentPath({
    directoryName,
    filePrefix,
    employeeId,
    attachmentDescriptor,
  });
  return writeBuffer(destinationRoot, relativePath, buffer);
}

async function writeBuffer(destinationRoot, relativePath, buffer) {
  const absolutePath = path.join(destinationRoot, relativePath);
  await fs.mkdir(path.dirname(absolutePath), { recursive: true });
  await fs.writeFile(absolutePath, buffer);
  return {
    skipped: false,
    relativePath,
    absolutePath,
    bytes: buffer.length,
  };
}
