import { buildRaasUrl } from '../config.js';
import { runGeneratedDocumentExport } from '../lib/generated-document-runner.js';

const LIST_REPORT = 'CR_Export_Generated_Document_ID';

/**
 * job-description — Generated Document ID + blobitory PDF download
 *
 * Requirements lines 74–116:
 *   1. CR_Export_Generated_Document_ID → EmployeeID + DocumentID + Attachment
 *   2. Blobitory download per Document_ID
 *   3. Job_Description/100_{EmployeeId}_JobDescription_{AttachmentNoSpaces}
 *   4. SFTP /ROI/Workday/
 */
export async function runJobDescription(options = {}) {
  const listUrl = process.env.WORKDAY_JOB_DESCRIPTION_LIST_URL || buildRaasUrl(LIST_REPORT);

  return runGeneratedDocumentExport({
    apiName: 'job-description',
    listUrl,
    directoryName: 'Job_Description',
    filePrefix: 'JobDescription',
    categoryLabel: 'Job Description',
    documentLabel: 'Job Description',
    ...options,
  });
}
