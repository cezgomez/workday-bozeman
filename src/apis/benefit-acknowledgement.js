import { buildRaasUrl } from '../config.js';
import { runGeneratedDocumentExport } from '../lib/generated-document-runner.js';

const LIST_REPORT = 'CR_Export_Benefit_Acknowledgement';

/**
 * benefit-acknowledgement — Benefits Enrollment Acknowledgement via blobitory
 *
 * Requirements lines 245–289:
 *   1. CR_Export_Benefit_Acknowledgement → EmployeeID + DocumentID + Attachment
 *   2. Blobitory download per Document_ID
 *   3. Benefit_Acknowledgement/100_{EmployeeId}_BenefitAcknowledgement_{AttachmentNoSpaces}
 *   4. SFTP /ROI/Workday/
 *
 * Example:
 *   Benefit_Acknowledgement/100_41197_BenefitAcknowledgement_BenefitEnrollmentAcknowledgement2025-01-03.pdf
 */
export async function runBenefitAcknowledgement(options = {}) {
  const listUrl = process.env.WORKDAY_BENEFIT_ACKNOWLEDGEMENT_LIST_URL || buildRaasUrl(LIST_REPORT);

  return runGeneratedDocumentExport({
    apiName: 'benefit-acknowledgement',
    listUrl,
    directoryName: 'Benefit_Acknowledgement',
    filePrefix: 'BenefitAcknowledgement',
    categoryLabel: 'Benefits',
    documentLabel: 'Benefit Enrollment Acknowledgement',
    ...options,
  });
}
