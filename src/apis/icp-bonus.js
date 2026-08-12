import { buildRaasUrl } from '../config.js';
import { runGeneratedDocumentExport } from '../lib/generated-document-runner.js';

const LIST_REPORT = 'CR_Export_ICP_Bonus_Document';

/**
 * icp-bonus — Compensation ICP Bonus Document via blobitory
 *
 * Requirements lines 292–342:
 *   1. CR_Export_ICP_Bonus_Document → EmployeeID + DocumentID + Attachment
 *   2. Blobitory download per Document_ID
 *   3. ICP_Bonus/100_{EmployeeId}_ICPBonus_{AttachmentNoSpaces}
 *   4. SFTP /ROI/Workday/
 *
 * Example:
 *   ICP_Bonus/100_41197_ICPBonus_ICPBonusDocument2025-03-19.pdf
 */
export async function runIcpBonus(options = {}) {
  const listUrl = process.env.WORKDAY_ICP_BONUS_LIST_URL || buildRaasUrl(LIST_REPORT);

  return runGeneratedDocumentExport({
    apiName: 'icp-bonus',
    listUrl,
    directoryName: 'ICP_Bonus',
    filePrefix: 'ICPBonus',
    categoryLabel: 'Compensation',
    documentLabel: 'ICP Bonus Document',
    ...options,
  });
}
