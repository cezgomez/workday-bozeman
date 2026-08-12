import { buildRaasUrl } from '../config.js';
import { runGeneratedDocumentExport } from '../lib/generated-document-runner.js';

const LIST_REPORT = 'CR_Export_Job_Offer_-_Copy';

/**
 * job-offer — Generated Offer Letter via blobitory
 *
 * Requirements lines 393–448:
 *   1. CR_Export_Job_Offer_-_Copy → EmployeeID + Document_ID + File
 *   2. Blobitory download per Document_ID
 *   3. Job_Offer/100_{EmployeeId}_JobOffer_{FileNoSpaces}
 *   4. SFTP /ROI/Workday/
 *
 * Note: report uses GeneratedOfferAttachments / File (not Review_Documents_group / Attachment).
 *
 * Example:
 *   Job_Offer/100_45135_JobOffer_DefaultOfferLetter02222021.pdf
 */
export async function runJobOffer(options = {}) {
  const listUrl = process.env.WORKDAY_JOB_OFFER_LIST_URL || buildRaasUrl(LIST_REPORT);

  return runGeneratedDocumentExport({
    apiName: 'job-offer',
    listUrl,
    directoryName: 'Job_Offer',
    filePrefix: 'JobOffer',
    categoryLabel: 'Offers',
    documentLabel: 'Job Offer',
    ...options,
  });
}
