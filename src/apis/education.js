import { MOCK_FTP_DIR, getWorkdayConfig, getBlobitoryConfig, buildRaasUrl, buildStaffingUrl } from '../config.js';
import { fetchWorkersReport } from '../lib/workday-client.js';
import { fetchWorkerDocumentsSoap } from '../lib/staffing-client.js';
import {
  parseEducationListXml,
  parseWorkerDocumentsSoap,
} from '../lib/education-list.js';
import { saveGeneratedDocumentFile } from '../lib/file-saver.js';
import { FtpUploader } from '../lib/sftp-client.js';
import { mapPool } from '../lib/parallel.js';
import { writeRunReport } from '../lib/run-report.js';
import { chunkPages } from '../lib/worker-pager.js';

const LIST_REPORT = 'API_Education';

/**
 * education — Worker Document (Education) via Staffing SOAP
 *
 * Requirements lines 451–503:
 *   1. API_Education RaaS → EmployeeID + referenceID + Filename (Education category)
 *   2. Staffing Get_Workers (Include_Worker_Documents) per Employee_ID
 *   3. Match Worker_Document_Reference WID + EDUCATION category → File base64
 *   4. Education/100_{Worker_ID}_Education_{FilenameNoSpaces}
 *   5. SFTP /ROI/Workday/
 *
 * Example:
 *   Education/100_41197_Education_DocMar28,2022,3.57.pdf
 */
export async function runEducation(options = {}) {
  const {
    mock = false,
    pageSize = 5,
    maxPages = null,
    maxEmployees = null,
    concurrency = 5,
  } = options;

  const apiName = 'education';
  const directoryName = 'Education';
  const filePrefix = 'Education';
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

  const listUrl = process.env.WORKDAY_EDUCATION_LIST_URL || buildRaasUrl(LIST_REPORT);
  const staffingUrl =
    process.env.WORKDAY_STAFFING_URL || buildStaffingUrl();

  try {
    if (mock) {
      throw new Error(
        'education --mock true is not implemented (no sample SOAP body). Use --mock false.'
      );
    }

    const wd = getWorkdayConfig();
    // Staffing requires username@tenant (same form as blobitory)
    const blob = getBlobitoryConfig();
    const staffingUser =
      process.env.WORKDAY_STAFFING_USERNAME || blob.username;
    const staffingPassword =
      process.env.WORKDAY_STAFFING_PASSWORD ||
      blob.password ||
      wd.password;

    console.log(`[${apiName}] step 1/2: load Education RaaS list`);
    console.log(`[${apiName}]   ${listUrl}`);
    const listBody = await fetchWorkersReport({
      workersReportUrl: listUrl.includes('format=')
        ? listUrl
        : `${listUrl}${listUrl.includes('?') ? '&' : '?'}format=xml`,
      username: wd.username,
      password: wd.password,
    });
    console.log(`[${apiName}] list response received (${listBody.length} chars)`);

    const employees = parseEducationListXml(listBody);
    totals.employeesInWidsReport = employees.length;

    let list = employees;
    if (maxEmployees != null && maxEmployees > 0) {
      list = list.slice(0, maxEmployees);
    }
    totals.employeesWithAllowListedDocs = list.length;

    console.log(
      `[${apiName}] employees in list: ${employees.length}; processing: ${list.length}`
    );
    console.log(
      `[${apiName}] step 2/2: Staffing Get_Workers + Education File download → SFTP`
    );
    console.log(`[${apiName}]   ${staffingUrl}`);

    const pages = chunkPages(list, pageSize);
    const pageLimit =
      maxPages != null ? Math.min(pages.length, maxPages) : pages.length;

    const uploader = new FtpUploader();
    try {
      await uploader.connect();

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
          const part = {
            parsed: emp.documents.length,
            matched: 0,
            skippedFilter: 0,
            saved: [],
            skipped: [],
            errors: [],
            uploaded: [],
          };

          try {
            console.log(
              `  [start] ${label} listDocs=${emp.documents.length}`
            );
            const soapXml = await fetchWorkerDocumentsSoap({
              employeeId: emp.employeeId,
              username: staffingUser,
              password: staffingPassword,
              staffingUrl,
            });

            const referenceIds = emp.documents
              .map((d) => d.referenceId)
              .filter(Boolean);

            let { workerId, documents } = parseWorkerDocumentsSoap(soapXml, {
              referenceIds,
              educationOnly: true,
            });

            // If reference match found nothing (schema drift), fall back to all EDUCATION
            if (documents.length === 0 && referenceIds.length > 0) {
              ({ workerId, documents } = parseWorkerDocumentsSoap(soapXml, {
                educationOnly: true,
              }));
            }

            part.matched = documents.length;
            if (documents.length === 0) {
              totals.workersSkippedNoMatch += 1;
              console.log(`  [skip]  ${label}: no Education File in Staffing response`);
              return part;
            }

            const workerKey = workerId || emp.employeeId;

            for (const doc of documents) {
              try {
                const buffer = Buffer.from(doc.fileBase64, 'base64');
                const outcome = await saveGeneratedDocumentFile(MOCK_FTP_DIR, {
                  directoryName,
                  filePrefix,
                  employeeId: workerKey,
                  attachmentDescriptor: doc.filename,
                  buffer,
                });

                part.saved.push({
                  employeeId: workerKey,
                  document: 'Education',
                  docCategory: 'Education',
                  path: outcome.relativePath,
                  bytes: outcome.bytes,
                  attachment: doc.filename,
                });
                console.log(
                  `    save  ${outcome.relativePath} (${outcome.bytes} bytes)`
                );

                const remote = await uploader.upload({
                  relativePath: outcome.relativePath,
                  localPath: outcome.absolutePath,
                });
                part.uploaded.push({
                  employeeId: workerKey,
                  document: 'Education',
                  docCategory: 'Education',
                  path: outcome.relativePath,
                  remotePath: remote.remotePath,
                });
                console.log(`    sftp  ${remote.remotePath}`);
              } catch (err) {
                part.errors.push({
                  employeeId: workerKey,
                  document: doc.filename,
                  error: err.message,
                });
                console.error(`    error ${label} ${doc.filename}: ${err.message}`);
              }
            }

            console.log(
              `  [done]  ${label}: saved=${part.saved.length} uploaded=${part.uploaded.length} errors=${part.errors.length}`
            );
          } catch (err) {
            part.errors.push({
              employeeId: emp.employeeId,
              error: err.message,
            });
            totals.workerErrors.push({
              employeeId: emp.employeeId,
              error: err.message,
            });
            console.error(`  [error] ${label}: ${err.message}`);
          }

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
      await uploader.end();
    }
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
