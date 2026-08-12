import { MOCK_FTP_DIR, getWorkdayConfig, buildRaasUrl } from '../config.js';
import { fetchWorkersReport } from '../lib/workday-client.js';
import {
  WORKPLACE_TEST_DIRECTORIES,
  parseWorkplaceTestListXml,
  parseWorkplaceTestDetailXml,
  selectWorkplaceTestWork,
} from '../lib/workplace-test-list.js';
import { saveAttachment } from '../lib/file-saver.js';
import { FtpUploader } from '../lib/sftp-client.js';
import { mapPool } from '../lib/parallel.js';
import { writeRunReport } from '../lib/run-report.js';
import { chunkPages } from '../lib/worker-pager.js';
import fs from 'node:fs/promises';
import path from 'node:path';

const LIST_REPORT = 'CR_Export_Workplace_Test';

const DETAIL_REPORT = 'CR_Export_Workplace_Test_Copy';

/**
 * workplace-test — Add Workplace Test attachments by test-type directory
 *
 * Requirements lines 507–630:
 *   1. CR_Export_Workplace_Test (all) → EmployeeID + workdayID + WPTestType + WPAttachment WID
 *   2. CR_Export_Workplace_Test_Copy?Worker!WID=… → Base64 content
 *   3. Match Attachment WID / WDWID
 *   4. {WPTestType}/100_{EmployeeId}_{WPTestTypeNoSpaces}_{AttachmentNoSpaces}
 *   5. Only allow-listed test type directories
 *   6. First N employees per directory (default 20)
 *
 * Example:
 *   Tuberculosis_Test_-_QuantiFERON-TB_Gold/100_46929_TuberculosisTest-QuantiFERON-TBGold_AmeliaA.Fogg.pdf
 */
export async function runWorkplaceTest(options = {}) {
  const {
    mock = false,
    pageSize = 5,
    maxPages = null,
    maxEmployees = 20,
    concurrency = 5,
  } = options;

  const apiName = 'workplace-test';
  const startedAt = new Date().toISOString();
  const startedMs = Date.now();
  const maxPerDir = maxEmployees ?? 20;

  console.log(
    `[${apiName}] mode=${mock ? 'mock' : 'live'} pageSize=${pageSize} ` +
      `concurrency=${concurrency} maxEmployeesPerDirectory=${maxPerDir}`
  );
  console.log(`[${apiName}] local output: ${MOCK_FTP_DIR}`);
  console.log(`[${apiName}] started: ${startedAt}`);
  console.log(
    `[${apiName}] directories (${WORKPLACE_TEST_DIRECTORIES.length}): ` +
      WORKPLACE_TEST_DIRECTORIES.join(' | ')
  );

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
    perDirectory: {},
  };

  const listUrl = process.env.WORKDAY_WORKPLACE_TEST_LIST_URL || buildRaasUrl(LIST_REPORT);
  const detailUrl =
    process.env.WORKDAY_WORKPLACE_TEST_DETAIL_URL || buildRaasUrl(DETAIL_REPORT);

  try {
    if (mock) {
      throw new Error(
        'workplace-test --mock true is not implemented. Use --mock false.'
      );
    }

    const wd = getWorkdayConfig();

    // --- Step 1: full metadata list ---
    console.log(`[${apiName}] step 1/2: load Workplace Test list (all employees)`);
    console.log(`[${apiName}]   ${listUrl}`);
    const listBody = await fetchWorkersReport({
      workersReportUrl: withFormatXml(listUrl),
      username: wd.username,
      password: wd.password,
      timeoutMs: 10 * 60 * 1000,
    });
    console.log(`[${apiName}] list response received (${listBody.length} chars)`);

    const employees = parseWorkplaceTestListXml(listBody);
    totals.employeesInWidsReport = employees.length;
    totals.parsed = employees.reduce((n, e) => n + e.tests.length, 0);

    const { byDirectory, workItems, workersNeeded } = selectWorkplaceTestWork({
      employees,
      maxEmployeesPerDirectory: maxPerDir,
      allowedTypes: WORKPLACE_TEST_DIRECTORIES,
    });

    // Log per-directory selection
    console.log(`[${apiName}] selection (max ${maxPerDir} employees per directory):`);
    for (const [dir, items] of byDirectory) {
      const empCount = items.length;
      const docCount = workItems.filter((w) => w.testType === dir).length;
      totals.perDirectory[dir] = {
        employeesSelected: empCount,
        documentsQueued: docCount,
        saved: 0,
        uploaded: 0,
        errors: 0,
      };
      console.log(
        `  - ${dir}: ${empCount} employee(s), ${docCount} document(s)`
      );
    }

    const uniqueWorkers = [...workersNeeded.values()];
    totals.employeesWithAllowListedDocs = uniqueWorkers.length;
    totals.matched = workItems.length;

    console.log(
      `[${apiName}] unique workers to fetch detail: ${uniqueWorkers.length}; ` +
        `document work items: ${workItems.length}`
    );

    if (uniqueWorkers.length === 0) {
      console.log(`[${apiName}] nothing to process`);
      return totals;
    }

    // Index work items by workdayId for quick lookup after detail fetch
    /** @type {Map<string, typeof workItems>} */
    const itemsByWorker = new Map();
    for (const item of workItems) {
      if (!item.workdayId) continue;
      if (!itemsByWorker.has(item.workdayId)) itemsByWorker.set(item.workdayId, []);
      itemsByWorker.get(item.workdayId).push(item);
    }

    // --- Step 2: detail per worker ---
    console.log(`[${apiName}] step 2/2: detail RaaS per Worker!WID → save + SFTP`);
    console.log(`[${apiName}]   ${detailUrl}`);

    let workerList = uniqueWorkers;
    // Optional batching via pageSize/maxPages over unique workers
    const pages = chunkPages(workerList, pageSize);
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
            `(${page.length} worker(s), concurrency=${concurrency})`
        );

        const batchResults = await mapPool(page, concurrency, async (worker) => {
          totals.workersProcessed += 1;
          const label = `emp=${worker.employeeId}`;
          const part = {
            parsed: 0,
            matched: 0,
            skippedFilter: 0,
            saved: [],
            skipped: [],
            errors: [],
            uploaded: [],
          };

          const items = itemsByWorker.get(worker.workdayId) || [];
          part.parsed = items.length;

          try {
            console.log(
              `  [start] ${label} workdayID=${worker.workdayId.slice(0, 12)}… docs=${items.length}`
            );

            const detailBody = await fetchWorkersReport({
              workersReportUrl: detailUrlForWorker(detailUrl, worker.workdayId),
              username: wd.username,
              password: wd.password,
              timeoutMs: 5 * 60 * 1000,
            });

            const byWid = parseWorkplaceTestDetailXml(detailBody);
            // Secondary index by attachment filename (fallback when WID missing/mismatched)
            const byName = new Map();
            for (const [wid, val] of byWid) {
              const key = normalizeName(val.attachmentDescriptor);
              if (key && !byName.has(key)) byName.set(key, val);
            }
            part.matched = items.length;

            for (const item of items) {
              try {
                let hit =
                  (item.attachmentWid && byWid.get(item.attachmentWid)) || null;
                if (!hit?.base64 && item.attachmentDescriptor) {
                  hit = byName.get(normalizeName(item.attachmentDescriptor)) || null;
                }
                // Last resort: if worker has exactly one detail attachment, use it
                if (!hit?.base64 && byWid.size === 1) {
                  hit = [...byWid.values()][0];
                }

                if (!hit?.base64) {
                  part.errors.push({
                    employeeId: item.employeeId,
                    document: item.testType,
                    error: `No Base64 for attachment WID ${item.attachmentWid || '(missing)'} name=${item.attachmentDescriptor}`,
                  });
                  console.log(
                    `    miss  ${label} type=${item.testType} wid=${item.attachmentWid || ''} name=${item.attachmentDescriptor}`
                  );
                  if (totals.perDirectory[item.testType]) {
                    totals.perDirectory[item.testType].errors += 1;
                  }
                  continue;
                }

                const attachmentDescriptor =
                  hit.attachmentDescriptor || item.attachmentDescriptor;

                const outcome = await saveAttachment(MOCK_FTP_DIR, {
                  documentDescriptor: item.testType,
                  employeeId: item.employeeId,
                  attachmentDescriptor,
                  attachmentBase64: hit.base64,
                });

                if (outcome.skipped) {
                  part.skipped.push({
                    employeeId: item.employeeId,
                    reason: outcome.reason,
                  });
                  continue;
                }

                part.saved.push({
                  employeeId: item.employeeId,
                  document: item.testType,
                  docCategory: item.testType,
                  path: outcome.relativePath,
                  bytes: outcome.bytes,
                  attachment: attachmentDescriptor,
                });
                console.log(
                  `    save  ${outcome.relativePath} (${outcome.bytes} bytes)`
                );

                const remote = await uploader.upload({
                  relativePath: outcome.relativePath,
                  localPath: outcome.absolutePath,
                });
                part.uploaded.push({
                  employeeId: item.employeeId,
                  document: item.testType,
                  docCategory: item.testType,
                  path: outcome.relativePath,
                  remotePath: remote.remotePath,
                });
                console.log(`    sftp  ${remote.remotePath}`);

                if (totals.perDirectory[item.testType]) {
                  totals.perDirectory[item.testType].saved += 1;
                  totals.perDirectory[item.testType].uploaded += 1;
                }
              } catch (err) {
                part.errors.push({
                  employeeId: item.employeeId,
                  document: item.testType,
                  error: err.message,
                });
                console.error(
                  `    error ${label} ${item.testType}: ${err.message}`
                );
                if (totals.perDirectory[item.testType]) {
                  totals.perDirectory[item.testType].errors += 1;
                }
              }
            }

            console.log(
              `  [done]  ${label}: saved=${part.saved.length} uploaded=${part.uploaded.length} errors=${part.errors.length}`
            );
          } catch (err) {
            part.errors.push({ employeeId: worker.employeeId, error: err.message });
            totals.workerErrors.push({
              employeeId: worker.employeeId,
              error: err.message,
            });
            console.error(`  [error] ${label}: ${err.message}`);
          }

          return part;
        });

        for (const part of batchResults) {
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
      `[${apiName}] done. workers=${totals.workersProcessed} saved=${totals.saved.length} ` +
        `uploaded=${totals.uploaded.length} errors=${totals.errors.length} ` +
        `workerErrors=${totals.workerErrors.length} duration=${Math.round(durationMs / 1000)}s`
    );

    // Extra per-directory summary in console
    console.log(`[${apiName}] per-directory results:`);
    for (const [dir, stats] of Object.entries(totals.perDirectory)) {
      console.log(
        `  - ${dir}: selected=${stats.employeesSelected} saved=${stats.saved} uploaded=${stats.uploaded} errors=${stats.errors}`
      );
    }

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

    // Also write a directory-focused summary alongside latest report
    try {
      const reportsDir = path.join(MOCK_FTP_DIR, '..', 'reports');
      await fs.mkdir(reportsDir, { recursive: true });
      const summary = {
        api: apiName,
        startedAt,
        finishedAt,
        maxEmployeesPerDirectory: maxPerDir,
        perDirectory: totals.perDirectory,
        totals: {
          workersProcessed: totals.workersProcessed,
          saved: totals.saved.length,
          uploaded: totals.uploaded.length,
          errors: totals.errors.length,
        },
      };
      await fs.writeFile(
        path.join(reportsDir, 'workplace-test-per-directory.json'),
        JSON.stringify(summary, null, 2),
        'utf8'
      );
    } catch {
      /* non-fatal */
    }
  }

  return totals;
}

function withFormatXml(url) {
  try {
    const u = new URL(url);
    if (!u.searchParams.has('format')) u.searchParams.set('format', 'xml');
    // Ensure we do not pin a single worker on the list report
    u.searchParams.delete('Worker!WID');
    return u.toString();
  } catch {
    return url.includes('format=') ? url : `${url}${url.includes('?') ? '&' : '?'}format=xml`;
  }
}

function detailUrlForWorker(baseUrl, workdayId) {
  const u = new URL(baseUrl);
  u.searchParams.set('format', 'xml');
  u.searchParams.set('Worker!WID', workdayId);
  return u.toString();
}

function normalizeName(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/\s+/g, '')
    .trim();
}
