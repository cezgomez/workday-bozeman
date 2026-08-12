import { buildRaasUrl } from '../config.js';
import { runGeneratedDocumentExport } from '../lib/generated-document-runner.js';

const LIST_REPORT = 'CR_Export_RN_Months_of_Experience';

/**
 * rn-experience — RN Months of Experience Form via blobitory
 *
 * Requirements lines 345–390:
 *   1. CR_Export_RN_Months_of_Experience → EmployeeID + DocumentID + Attachment
 *   2. Blobitory download per Document_ID
 *   3. RN_Experience/100_{EmployeeId}_RNExperience_{AttachmentNoSpaces}
 *   4. SFTP /ROI/Workday/
 *
 * Example:
 *   RN_Experience/100_41197_RNExperience_RNMonthsofExperienceForm2025-06-03.pdf
 */
export async function runRnExperience(options = {}) {
  const listUrl = process.env.WORKDAY_RN_EXPERIENCE_LIST_URL || buildRaasUrl(LIST_REPORT);

  return runGeneratedDocumentExport({
    apiName: 'rn-experience',
    listUrl,
    directoryName: 'RN_Experience',
    filePrefix: 'RNExperience',
    categoryLabel: 'Offers',
    documentLabel: 'RN Months of Experience Form',
    ...options,
  });
}
