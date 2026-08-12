import { buildRaasUrl } from '../config.js';
import { runGeneratedDocumentExport } from '../lib/generated-document-runner.js';

const LIST_REPORT = 'CR_Export_Market_Adjustment_Letter_-_Copy';

/**
 * market-adjustment — Compensation Market Adjustment Letter via blobitory
 *
 * Requirements lines 118–168:
 *   1. CR_Export_Market_Adjustment_Letter_-_Copy → EmployeeID + DocumentID + Attachment
 *   2. Blobitory download per Document_ID
 *   3. Market_Adjustment/100_{EmployeeId}_MarketAdjustment_{AttachmentNoSpaces}
 *   4. SFTP /ROI/Workday/
 */
export async function runMarketAdjustment(options = {}) {
  const listUrl = process.env.WORKDAY_MARKET_ADJUSTMENT_LIST_URL || buildRaasUrl(LIST_REPORT);

  return runGeneratedDocumentExport({
    apiName: 'market-adjustment',
    listUrl,
    directoryName: 'Market_Adjustment',
    filePrefix: 'MarketAdjustment',
    categoryLabel: 'Compensation',
    documentLabel: 'Market Adjustment Letter',
    ...options,
  });
}
