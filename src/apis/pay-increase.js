import { buildRaasUrl } from '../config.js';
import { runGeneratedDocumentExport } from '../lib/generated-document-runner.js';

const LIST_REPORT = 'CR_Export_Pay_Increase_-_Copy';

/**
 * pay-increase — Compensation Pay Increase letters via blobitory
 *
 * Requirements lines 118–190:
 *   1. CR_Export_Pay_Increase_-_Copy → EmployeeID + DocumentID + Attachment
 *   2. Blobitory download per Document_ID
 *   3. Pay_Increase/100_{EmployeeId}_PayIncrease_{AttachmentNoSpaces}
 *   4. SFTP /ROI/Workday/
 *
 * Example:
 *   Pay_Increase/100_41197_PayIncrease_2025PayIncrease2025-04-18.pdf
 */
export async function runPayIncrease(options = {}) {
  const listUrl = process.env.WORKDAY_PAY_INCREASE_LIST_URL || buildRaasUrl(LIST_REPORT);

  return runGeneratedDocumentExport({
    apiName: 'pay-increase',
    listUrl,
    directoryName: 'Pay_Increase',
    filePrefix: 'PayIncrease',
    categoryLabel: 'Compensation',
    documentLabel: 'Pay Increase',
    ...options,
  });
}
