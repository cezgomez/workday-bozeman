import { MOCK_FTP_DIR, getWorkdayConfig, getBlobitoryConfig } from '../config.js';
import { fetchWorkersReport } from './workday-client.js';
import { fetchBlobitoryDocument } from './blobitory-client.js';
import { saveGeneratedDocumentFile } from './file-saver.js';
import { FtpUploader } from './sftp-client.js';
import { mapPool } from './parallel.js';
import { writeRunReport } from './run-report.js';
import { chunkPages } from './worker-pager.js';
import { parseGeneratedDocumentList } from './generated-document-list.js';

/**
 * Shared runner for blobitory-based document exports (job-description, market-adjustment, …).
 *
 * @param {object} options
 * @param {string} options.apiName - CLI --api name (for logs/reports)
 * @param {string} options.listUrl - RaaS list URL (EmployeeID + DocumentID + Attachment)
 * @param {string} options.directoryName - e.g. Job_Description, Market_Adjustment
 * @param {string} options.filePrefix - e.g. JobDescription, MarketAdjustment
 * @param {string} options.categoryLabel - metrics category label
 * @param {string} [options.documentLabel] - metrics document label
 */
export async function runGeneratedDocumentExport({
  apiName,
  listUrl,
  directoryName,
  filePrefix,
  categoryLabel,
  documentLabel = categoryLabel,
  mock = false,
  pageSize = 5,
  maxPages = null,
  maxEmployees = null,
  concurrency = 5,
  sampleBody = null,
}) {
  const startedAt = new Date().toISOString();
  const startedMs = Date.now();

  console.log(
    `[${apiName}] mode=${mock ? 'mock' : 'live'} pageSize=${pageSize} ` +
      `concurrency=${concurrency} maxEmployees=${maxEmployees ?? 'all'}`
  );
  console.log(`[${apiName}] local output: ${MOCK_FTP_DIR}`);
  console.log(`[${apiName}] started: ${startedAt}`);

  const totals = {
    parsed: 0,
    matched: 0,
    skippedFilter: 0,
    saved: [],
    skipped: [],
    errors: [],
    uploaded: [],
    pages: 0,
    workersProcessed: 0,
    workersSkippedNoMatch: 0,
    workerErrors: [],
    employeesInWidsReport: null,
    employeesWithAllowListedDocs: null,
  };

  try {
    let body;
    if (mock && sampleBody) {
      body = sampleBody;
      console.log(`[${apiName}] using sample list body`);
    } else {
      const wd = getWorkdayConfig();
      console.log(`[${apiName}] step 1/2: load EmployeeID + DocumentID list`);
      console.log(`[${apiName}]   ${listUrl}`);
      body = await fetchWorkersReport({
        workersReportUrl: listUrl,
        username: wd.username,
        password: wd.password,
      });
      console.log(`[${apiName}] list response received (${body.length} chars)`);
    }

    const employees = parseGeneratedDocumentList(body, {
      defaultAttachmentName: `${filePrefix}.pdf`,
    });
    await processEmployees(employees, {
      apiName,
      directoryName,
      filePrefix,
      categoryLabel,
      documentLabel,
      pageSize,
      maxPages,
      maxEmployees,
      concurrency,
      totals,
      live: true,
    });
  } finally {
    const finishedAt = new Date().toISOString();
    const durationMs = Date.now() - startedMs;
    console.log(
      `[${apiName}] done. employees=${totals.workersProcessed} saved=${totals.saved.length} ` +
        `uploaded=${totals.uploaded.length} errors=${totals.errors.length} ` +
        `workerErrors=${totals.workerErrors.length} duration=${Math.round(durationMs / 1000)}s`
    );
    await writeRunReport({
      api: apiName,
      mode: mock ? 'mock' : 'live',
      startedAt,
      finishedAt,
      durationMs,
      totals,
      pageSize,
      concurrency,
      maxPages,
    });
  }

  return totals;
}

async function processEmployees(
  employees,
  {
    apiName,
    directoryName,
    filePrefix,
    categoryLabel,
    documentLabel,
    pageSize,
    maxPages,
    maxEmployees,
    concurrency,
    totals,
    live,
  }
) {
  totals.employeesInWidsReport = employees.length;

  let list = employees;
  if (maxEmployees != null && maxEmployees > 0) {
    list = list.slice(0, maxEmployees);
  }

  totals.employeesWithAllowListedDocs = list.length;
  console.log(
    `[${apiName}] employees in list: ${employees.length}; processing: ${list.length}`
  );

  const pages = chunkPages(list, pageSize);
  const pageLimit = maxPages != null ? Math.min(pages.length, maxPages) : pages.length;

  const uploader = live ? new FtpUploader() : null;
  try {
    if (uploader) await uploader.connect();
    const blobCfg = getBlobitoryConfig();

    for (let p = 0; p < pageLimit; p++) {
      const page = pages[p];
      totals.pages += 1;
      console.log(
        `[${apiName}] batch ${p + 1}/${pageLimit} ` +
          `(${page.length} employee(s), concurrency=${concurrency})`
      );

      const batchResults = await mapPool(page, concurrency, async (emp) => {
        totals.workersProcessed += 1;
        const label = `emp=${emp.employeeId}`;
        console.log(`  [start] ${label} docs=${emp.documents.length}`);
        const part = {
          parsed: emp.documents.length,
          matched: emp.documents.length,
          skippedFilter: 0,
          saved: [],
          skipped: [],
          errors: [],
          uploaded: [],
        };

        for (const doc of emp.documents) {
          try {
            console.log(`    [blob] ${label} DocumentID=${doc.documentId}`);
            const { buffer } = await fetchBlobitoryDocument({
              documentId: doc.documentId,
              tenant: blobCfg.tenant,
              host: blobCfg.host,
              username: blobCfg.username,
              password: blobCfg.password,
            });

            const outcome = await saveGeneratedDocumentFile(MOCK_FTP_DIR, {
              directoryName,
              filePrefix,
              employeeId: emp.employeeId,
              attachmentDescriptor: doc.attachmentDescriptor,
              buffer,
            });

            part.saved.push({
              employeeId: emp.employeeId,
              document: documentLabel,
              docCategory: categoryLabel,
              path: outcome.relativePath,
              bytes: outcome.bytes,
              attachment: doc.attachmentDescriptor,
            });
            console.log(`    save  ${outcome.relativePath} (${outcome.bytes} bytes)`);

            if (uploader) {
              const remote = await uploader.upload({
                relativePath: outcome.relativePath,
                localPath: outcome.absolutePath,
              });
              part.uploaded.push({
                employeeId: emp.employeeId,
                document: documentLabel,
                docCategory: categoryLabel,
                path: outcome.relativePath,
                remotePath: remote.remotePath,
              });
              console.log(`    sftp  ${remote.remotePath}`);
            }
          } catch (err) {
            part.errors.push({
              employeeId: emp.employeeId,
              document: doc.attachmentDescriptor,
              error: err.message,
            });
            console.error(`    error ${label}: ${err.message}`);
          }
        }

        console.log(
          `  [done]  ${label}: saved=${part.saved.length} uploaded=${part.uploaded.length} errors=${part.errors.length}`
        );
        return part;
      });

      for (const part of batchResults) {
        totals.parsed += part.parsed;
        totals.matched += part.matched;
        totals.skippedFilter += part.skippedFilter;
        totals.saved.push(...part.saved);
        totals.skipped.push(...part.skipped);
        totals.errors.push(...part.errors);
        totals.uploaded.push(...part.uploaded);
      }
    }
  } finally {
    if (uploader) await uploader.end();
  }
}
