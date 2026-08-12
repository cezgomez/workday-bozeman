import { MOCK_FTP_DIR, getWorkdayConfig, buildRaasUrl } from '../config.js';
import { fetchWorkersReport } from '../lib/workday-client.js';
import {
  parseBenefitEventListXml,
  parseBenefitEventDetailXml,
} from '../lib/benefit-event-list.js';
import { saveGeneratedDocumentFile } from '../lib/file-saver.js';
import { FtpUploader } from '../lib/sftp-client.js';
import { mapPool } from '../lib/parallel.js';
import { writeRunReport } from '../lib/run-report.js';
import { chunkPages } from '../lib/worker-pager.js';

const LIST_REPORT = 'CR_Export_Elderly__Abuse_Form_-_Copy';

/** Full report includes Attachment + Base64 (may be large). */
const DETAIL_REPORT = 'CR_Export_Elderly__Abuse_Form';

/**
 * elderly-abuse — Montana Elder and Disability form attachments
 *
 * Requirements lines 966–1082:
 *   1. CR_Export_Elderly__Abuse_Form_-_Copy → EmployeeID + workdayID + WDWID
 *   2. CR_Export_Elderly__Abuse_Form (all / or per worker if needed) → Attachment + Base64
 *   3. Match WDWID
 *   4. Elderly_Abuse/100_{EmployeeId}_ElderlyAbuse_{AttachmentNoSpaces}
 *   5. SFTP /ROI/Workday/
 *
 * Example:
 *   Elderly_Abuse/100_35367_ElderlyAbuse_IMG0201.jpeg
 */
export async function runElderlyAbuse(options = {}) {
  const {
    mock = false,
    pageSize = 5,
    maxPages = null,
    maxEmployees = 20,
    concurrency = 5,
  } = options;

  const apiName = 'elderly-abuse';
  const directoryName = 'Elderly_Abuse';
  const filePrefix = 'ElderlyAbuse';
  const startedAt = new Date().toISOString();
  const startedMs = Date.now();
  const maxEmp = maxEmployees ?? 20;

  console.log(
    `[${apiName}] mode=${mock ? 'mock' : 'live'} pageSize=${pageSize} ` +
      `concurrency=${concurrency} maxEmployees=${maxEmp}`
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

  const listUrl = process.env.WORKDAY_ELDERLY_ABUSE_LIST_URL || buildRaasUrl(LIST_REPORT);
  const detailUrl =
    process.env.WORKDAY_ELDERLY_ABUSE_DETAIL_URL || buildRaasUrl(DETAIL_REPORT);

  try {
    if (mock) {
      throw new Error(
        'elderly-abuse --mock true is not implemented. Use --mock false.'
      );
    }

    const wd = getWorkdayConfig();

    console.log(`[${apiName}] step 1/2: load Elderly Abuse list`);
    console.log(`[${apiName}]   ${listUrl}`);
    const listBody = await fetchWorkersReport({
      workersReportUrl: withFormatXml(listUrl),
      username: wd.username,
      password: wd.password,
      timeoutMs: 10 * 60 * 1000,
    });
    console.log(`[${apiName}] list response received (${listBody.length} chars)`);

    const employees = parseBenefitEventListXml(listBody);
    totals.employeesInWidsReport = employees.length;
    totals.parsed = employees.reduce((n, e) => n + e.documents.length, 0);

    let list = employees;
    if (maxEmp != null && maxEmp > 0) {
      list = list.slice(0, maxEmp);
    }
    totals.employeesWithAllowListedDocs = list.length;

    console.log(
      `[${apiName}] employees in list: ${employees.length}; processing: ${list.length}`
    );

    // Prefer one full detail pull (report includes Base64 for all rows).
    // Falls back to per-worker only if bulk detail fails.
    console.log(`[${apiName}] step 2/2: detail report with Base64 → save + SFTP`);
    console.log(`[${apiName}]   ${detailUrl}`);

    let bulkByWid = null;
    try {
      const detailBody = await fetchWorkersReport({
        workersReportUrl: withFormatXml(detailUrl),
        username: wd.username,
        password: wd.password,
        timeoutMs: 15 * 60 * 1000,
      });
      console.log(
        `[${apiName}] detail response received (${detailBody.length} chars)`
      );
      bulkByWid = parseBenefitEventDetailXml(detailBody);
      console.log(`[${apiName}] detail attachments with Base64: ${bulkByWid.size}`);
    } catch (err) {
      console.log(
        `[${apiName}] bulk detail failed (${err.message.slice(0, 200)}); will try per-worker`
      );
    }

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
              `  [start] ${label} docs=${emp.documents.length}`
            );

            let byWid = bulkByWid;
            if (!byWid || byWid.size === 0) {
              // Per-worker detail (if report supports Worker!WID)
              try {
                const detailBody = await fetchWorkersReport({
                  workersReportUrl: detailUrlForWorker(detailUrl, emp.workdayId),
                  username: wd.username,
                  password: wd.password,
                  timeoutMs: 5 * 60 * 1000,
                });
                byWid = parseBenefitEventDetailXml(detailBody);
              } catch {
                byWid = new Map();
              }
            }

            const expectedWids = new Set(
              emp.documents.map((d) => d.wdwid).filter(Boolean)
            );

            let docsToSave = [];
            for (const wid of expectedWids) {
              const hit = byWid?.get(wid);
              if (hit) docsToSave.push({ ...hit, matchWid: wid });
            }
            // If no WDWWID matches but we have bulk data for this employee, take all their docs
            if (docsToSave.length === 0 && byWid) {
              for (const hit of byWid.values()) {
                if (String(hit.employeeId) === String(emp.employeeId)) {
                  docsToSave.push({ ...hit, matchWid: hit.wdwid });
                }
              }
            }

            part.matched = docsToSave.length;
            if (docsToSave.length === 0) {
              totals.workersSkippedNoMatch += 1;
              console.log(`  [skip]  ${label}: no Base64 matched`);
              return part;
            }

            for (const doc of docsToSave) {
              try {
                const buffer = Buffer.from(doc.base64, 'base64');
                const outcome = await saveGeneratedDocumentFile(MOCK_FTP_DIR, {
                  directoryName,
                  filePrefix,
                  employeeId: emp.employeeId,
                  attachmentDescriptor: doc.attachmentDescriptor,
                  buffer,
                });

                part.saved.push({
                  employeeId: emp.employeeId,
                  document: 'Elderly Abuse',
                  docCategory: 'Personal Information',
                  path: outcome.relativePath,
                  bytes: outcome.bytes,
                  attachment: doc.attachmentDescriptor,
                });
                console.log(
                  `    save  ${outcome.relativePath} (${outcome.bytes} bytes)`
                );

                const remote = await uploader.upload({
                  relativePath: outcome.relativePath,
                  localPath: outcome.absolutePath,
                });
                part.uploaded.push({
                  employeeId: emp.employeeId,
                  document: 'Elderly Abuse',
                  docCategory: 'Personal Information',
                  path: outcome.relativePath,
                  remotePath: remote.remotePath,
                });
                console.log(`    sftp  ${remote.remotePath}`);
              } catch (err) {
                part.errors.push({
                  employeeId: emp.employeeId,
                  document: doc.attachmentDescriptor,
                  error: err.message,
                });
                console.log(
                  `    error ${label} ${doc.attachmentDescriptor}: ${err.message}`
                );
              }
            }

            console.log(
              `  [done]  ${label}: saved=${part.saved.length} uploaded=${part.uploaded.length} errors=${part.errors.length}`
            );
          } catch (err) {
            part.errors.push({ employeeId: emp.employeeId, error: err.message });
            totals.workerErrors.push({
              employeeId: emp.employeeId,
              error: err.message,
            });
            console.log(`  [error] ${label}: ${err.message}`);
          }

          return part;
        });

        for (const part of batchResults) {
          totals.matched += part.matched;
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

function withFormatXml(url) {
  try {
    const u = new URL(url);
    if (!u.searchParams.has('format')) u.searchParams.set('format', 'xml');
    u.searchParams.delete('Worker!WID');
    return u.toString();
  } catch {
    return url.includes('format=')
      ? url
      : `${url}${url.includes('?') ? '&' : '?'}format=xml`;
  }
}

function detailUrlForWorker(baseUrl, workdayId) {
  const u = new URL(baseUrl);
  u.searchParams.set('format', 'xml');
  u.searchParams.set('Worker!WID', workdayId);
  return u.toString();
}
