import fs from 'node:fs/promises';
import {
  MOCK_FTP_DIR,
  REPORT_INFO_DOCUMENT_FILTERS,
  SAMPLE_RESPONSE_PATH,
  getWorkdayConfig,
} from '../config.js';
import { mergeResults, processAndSaveRecords } from '../lib/process-records.js';
import { parseReviewDocumentXml } from '../lib/xml-parser.js';
import { fetchWorkdayReport, fetchWorkersReport } from '../lib/workday-client.js';
import { iterateWorkerPages } from '../lib/worker-pager.js';
import { FtpUploader } from '../lib/sftp-client.js';
import { mapPool } from '../lib/parallel.js';
import { writeRunReport } from '../lib/run-report.js';

/** Default parallel Worker!WID detail fetches */
const DEFAULT_CONCURRENCY = 5;

/**
 * report-info — Review Document pipeline
 *
 * All-employee flow (live, --mock false):
 *   1. WIDs-only report → all EmployeeID + workdayID
 *   2. Skip workers with no allow-listed doc metadata
 *   3. Batches of workers; within each batch fetch up to N in parallel
 *   4. Filter → ./mock → Infor SFTP /ROI/Workday/
 *   5. Write duration / employee / category metrics to reports/
 */
export async function runReportInfo({
  mock,
  workerWid = null,
  workersFile = null,
  pageSize = 5,
  maxPages = null,
  maxEmployees = null,
  concurrency = DEFAULT_CONCURRENCY,
}) {
  const startedAtDate = new Date();
  const startedAt = startedAtDate.toISOString();
  const startedMs = Date.now();

  console.log(
    `[report-info] mode=${mock ? 'mock' : 'live'} pageSize=${pageSize} ` +
      `concurrency=${concurrency} maxEmployees=${maxEmployees ?? 'all'}`
  );
  console.log(`[report-info] local output: ${MOCK_FTP_DIR}`);
  console.log(`[report-info] started: ${startedAt}`);

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
    if (mock) {
      await runMockPaged({ workerWid, workersFile, pageSize, maxPages, maxEmployees, totals });
    } else {
      await runLiveAllEmployees({
        workerWid,
        workersFile,
        pageSize,
        maxPages,
        maxEmployees,
        concurrency,
        totals,
      });
    }
  } finally {
    const finishedAtDate = new Date();
    const finishedAt = finishedAtDate.toISOString();
    const durationMs = Date.now() - startedMs;

    console.log(
      `[report-info] done. pages=${totals.pages} workers=${totals.workersProcessed} ` +
        `saved=${totals.saved.length} uploaded=${totals.uploaded.length} ` +
        `skipped=${totals.skipped.length} filterSkipped=${totals.skippedFilter} ` +
        `errors=${totals.errors.length} workerErrors=${totals.workerErrors.length} ` +
        `duration=${Math.round(durationMs / 1000)}s`
    );

    await writeRunReport({
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

async function runMockPaged({ workerWid, workersFile, pageSize, maxPages, maxEmployees, totals }) {
  console.log(`[report-info] reading sample: ${SAMPLE_RESPONSE_PATH}`);
  const xml = await fs.readFile(SAMPLE_RESPONSE_PATH, 'utf8');
  const allRecords = parseReviewDocumentXml(xml);

  const byWorker = groupRecordsByWorker(allRecords);
  const workersFromSample = [...byWorker.keys()].map((wid) => {
    const first = byWorker.get(wid)[0];
    return { wid, employeeId: first?.employeeId };
  });

  totals.employeesInWidsReport = workersFromSample.length;
  totals.employeesWithAllowListedDocs = workersFromSample.length;

  for await (const page of iterateWorkerPages({
    workerWid,
    workersFile,
    workers: workersFromSample,
    pageSize,
    maxPages,
    maxEmployees,
  })) {
    totals.pages += 1;
    console.log(
      `[report-info] page ${page.pageIndex}/${page.totalPages} ` +
        `(${page.workers.length} worker(s); total: ${page.totalWorkers})`
    );

    for (const worker of page.workers) {
      totals.workersProcessed += 1;
      const records = byWorker.get(worker.wid) || [];
      if (!records.length) {
        console.log(`  worker ${worker.wid}: no documents in sample XML`);
        continue;
      }
      console.log(
        `  worker wid=${worker.wid} emp=${records[0]?.employeeId ?? worker.employeeId ?? '?'} ` +
          `docs=${records.length}`
      );
      const part = await processAndSaveRecords(records, {
        filters: REPORT_INFO_DOCUMENT_FILTERS,
        destination: MOCK_FTP_DIR,
        logPrefix: '    ',
      });
      mergeResults(totals, part);
    }
  }
}

/**
 * Live: list ALL employees via WIDs-only report, then download docs per Worker!WID in parallel, SFTP upload.
 */
async function runLiveAllEmployees({
  workerWid,
  workersFile,
  pageSize,
  maxPages,
  maxEmployees,
  concurrency,
  totals,
}) {
  const wd = getWorkdayConfig();
  const effectiveWorkerWid = workerWid || wd.workerWid || null;

  let workersReportBody = null;
  if (!effectiveWorkerWid && !workersFile) {
    console.log(`[report-info] step 1/2: load ALL employee IDs/WIDs from WIDs-only report`);
    console.log(`[report-info]   ${wd.workersReportUrl}`);
    workersReportBody = await fetchWorkersReport({
      workersReportUrl: wd.workersReportUrl,
      username: wd.username,
      password: wd.password,
    });
    console.log(`[report-info] WIDs-only response received (${workersReportBody.length} chars)`);
  }

  const uploader = new FtpUploader();
  try {
    await uploader.connect();

    let loggedFilterStats = false;
    let lastProgressLog = Date.now();

    for await (const page of iterateWorkerPages({
      workerWid: effectiveWorkerWid,
      workersFile,
      workersReportBody,
      pageSize,
      maxPages,
      maxEmployees,
      onlyWithAllowedDocs: !effectiveWorkerWid && !workersFile,
      documentFilters: REPORT_INFO_DOCUMENT_FILTERS,
    })) {
      if (!loggedFilterStats && page.totalWorkersBeforeFilter != null) {
        const skipped = page.totalWorkersBeforeFilter - page.totalWorkers;
        totals.workersSkippedNoMatch = skipped;
        totals.employeesInWidsReport = page.totalWorkersBeforeFilter;
        totals.employeesWithAllowListedDocs = page.totalWorkers;
        console.log(
          `[report-info] employees in WIDs report: ${page.totalWorkersBeforeFilter}; ` +
            `with allow-listed docs: ${page.totalWorkers}; skipped: ${skipped}`
        );
        console.log(
          `[report-info] step 2/2: fetch detail per Worker!WID ` +
            `(batchSize=${pageSize}, concurrency=${concurrency})`
        );
        loggedFilterStats = true;
      }

      totals.pages += 1;
      console.log(
        `[report-info] batch ${page.pageIndex}/${page.totalPages} ` +
          `(${page.workers.length} worker(s) in parallel up to ${concurrency}; ` +
          `pool: ${page.totalWorkers})`
      );

      const parts = await mapPool(page.workers, concurrency, async (worker) => {
        totals.workersProcessed += 1;
        const label = worker.employeeId
          ? `emp=${worker.employeeId} wid=${worker.wid}`
          : `wid=${worker.wid}`;
        console.log(`  [start] ${label}`);
        try {
          const xml = await fetchWorkdayReport({
            reportUrl: wd.reportUrl,
            username: wd.username,
            password: wd.password,
            workerWid: worker.wid,
          });
          const records = parseReviewDocumentXml(xml);
          console.log(`  [docs]  ${label}: ${records.length} document group(s)`);
          const part = await processAndSaveRecords(records, {
            filters: REPORT_INFO_DOCUMENT_FILTERS,
            destination: MOCK_FTP_DIR,
            logPrefix: '    ',
            uploader,
          });
          console.log(
            `  [done]  ${label}: saved=${part.saved.length} uploaded=${part.uploaded.length}`
          );
          return { ok: true, part };
        } catch (err) {
          console.error(`  [fail]  ${label}: ${err.message}`);
          return {
            ok: false,
            wid: worker.wid,
            employeeId: worker.employeeId,
            error: err.message,
          };
        }
      });

      for (const result of parts) {
        if (result.ok) {
          mergeResults(totals, result.part);
        } else {
          totals.workerErrors.push({
            wid: result.wid,
            employeeId: result.employeeId,
            error: result.error,
          });
        }
      }

      // Periodic progress every ~2 minutes of wall time
      if (Date.now() - lastProgressLog > 120_000) {
        lastProgressLog = Date.now();
        console.log(
          `[report-info] progress: batch ${page.pageIndex}/${page.totalPages} ` +
            `workers=${totals.workersProcessed} saved=${totals.saved.length} ` +
            `uploaded=${totals.uploaded.length} errors=${totals.workerErrors.length}`
        );
      }
    }
  } finally {
    await uploader.end();
  }
}

function groupRecordsByWorker(records) {
  const map = new Map();
  for (const r of records) {
    const key = r.workdayId || `emp:${r.employeeId}` || 'unknown';
    if (!map.has(key)) map.set(key, []);
    map.get(key).push(r);
  }
  return map;
}
