import { MOCK_FTP_DIR, getWorkdayConfig, buildRaasUrl } from '../config.js';
import { fetchWorkersReport } from '../lib/workday-client.js';
import {
  parseResumeCoverLetterListXml,
  parseResumeCoverLetterDetailXml,
  classifyResumeDocument,
} from '../lib/resume-coverletter-list.js';
import { saveGeneratedDocumentFile } from '../lib/file-saver.js';
import { FtpUploader } from '../lib/sftp-client.js';
import { mapPool } from '../lib/parallel.js';
import { writeRunReport } from '../lib/run-report.js';
import { chunkPages } from '../lib/worker-pager.js';

const LIST_REPORT = 'CR_Export_Resume_Letter_and_CV_-_Copy';

const DETAIL_REPORT = 'CR_Export_Resume_Letter_and_CV';

/**
 * resume-coverletter — Candidate Resume / Cover Letter / Recommendation / CV
 *
 * Requirements lines 1217–1290:
 *   1. CR_Export_Resume_Letter_and_CV_-_Copy → EmployeeID + ResAttWID + fileName
 *   2. CR_Export_Resume_Letter_and_CV?Worker!WID=… → activeAttachmentContent
 *   3. Classify directory from fileName (Resume / Cover_Letter / Recommendation_Letter / CV)
 *   4. 1 unique Attachment Descriptor per Employee per Category (dedupe same name)
 *   5. {Category}/100_{EmployeeId}_{Category}_{fileNameNoSpaces}
 *   6. SFTP /ROI/Workday/
 *
 * Example:
 *   Resume/100_45031_Resume_AshleyKentResumeDecember2020.pdf
 */
export async function runResumeCoverLetter(options = {}) {
  const {
    mock = false,
    pageSize = 5,
    maxPages = null,
    maxEmployees = 20,
    concurrency = 5,
  } = options;

  const apiName = 'resume-coverletter';
  const startedAt = new Date().toISOString();
  const startedMs = Date.now();
  const maxEmp = maxEmployees ?? 20;

  console.log(
    `[${apiName}] mode=${mock ? 'mock' : 'live'} pageSize=${pageSize} ` +
      `concurrency=${concurrency} maxEmployees=${maxEmp}`
  );
  console.log(`[${apiName}] local output: ${MOCK_FTP_DIR}`);
  console.log(`[${apiName}] started: ${startedAt}`);
  console.log(
    `[${apiName}] categories: Resume | Cover_Letter | Recommendation_Letter | CV (default Resume)`
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
    perCategory: {
      Resume: 0,
      Cover_Letter: 0,
      Recommendation_Letter: 0,
      CV: 0,
    },
  };

  const listUrl =
    process.env.WORKDAY_RESUME_COVERLETTER_LIST_URL || buildRaasUrl(LIST_REPORT);
  const detailUrl =
    process.env.WORKDAY_RESUME_COVERLETTER_DETAIL_URL || buildRaasUrl(DETAIL_REPORT);

  try {
    if (mock) {
      throw new Error(
        'resume-coverletter --mock true is not implemented. Use --mock false.'
      );
    }

    const wd = getWorkdayConfig();

    console.log(`[${apiName}] step 1/2: load Resume/Cover Letter list`);
    console.log(`[${apiName}]   ${listUrl}`);
    const listBody = await fetchWorkersReport({
      workersReportUrl: withFormatXml(listUrl),
      username: wd.username,
      password: wd.password,
      timeoutMs: 15 * 60 * 1000,
    });
    console.log(`[${apiName}] list response received (${listBody.length} chars)`);

    const employees = parseResumeCoverLetterListXml(listBody);
    totals.employeesInWidsReport = employees.length;
    totals.parsed = employees.reduce((n, e) => n + e.attachments.length, 0);

    let list = employees;
    if (maxEmp != null && maxEmp > 0) {
      list = list.slice(0, maxEmp);
    }
    totals.employeesWithAllowListedDocs = list.length;

    console.log(
      `[${apiName}] unique employees in list: ${employees.length}; processing: ${list.length}`
    );
    // Preview classification for first few
    for (const e of list.slice(0, 3)) {
      console.log(
        `  sample emp=${e.employeeId}:`,
        e.attachments.map((a) => `${a.category}:${a.fileName}`).join(' | ')
      );
    }

    console.log(`[${apiName}] step 2/2: detail RaaS per Worker!WID → save + SFTP`);
    console.log(`[${apiName}]   ${detailUrl}`);

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
            parsed: emp.attachments.length,
            matched: 0,
            skippedFilter: 0,
            saved: [],
            skipped: [],
            errors: [],
            uploaded: [],
          };

          try {
            console.log(
              `  [start] ${label} workdayID=${String(emp.workdayId).slice(0, 12)}… planned=${emp.attachments.length}`
            );

            const detailBody = await fetchWorkersReport({
              workersReportUrl: detailUrlForWorker(detailUrl, emp.workdayId),
              username: wd.username,
              password: wd.password,
              timeoutMs: 5 * 60 * 1000,
            });

            const byWid = parseResumeCoverLetterDetailXml(detailBody);
            const allHits = [...byWid.values()];

            const docsToSave = [];
            for (const planned of emp.attachments) {
              let hit = planned.resAttWid
                ? byWid.get(planned.resAttWid)
                : null;
              // Fallback: match by file name
              if (!hit?.base64) {
                const key = normalizeLoose(planned.fileName);
                hit =
                  allHits.find(
                    (h) => normalizeLoose(h.fileName) === key
                  ) || null;
              }
              if (!hit?.base64) {
                part.errors.push({
                  employeeId: emp.employeeId,
                  document: planned.fileName,
                  error: `No activeAttachmentContent for ResAttWID ${planned.resAttWid || '(missing)'}`,
                });
                console.log(
                  `    miss  ${label} ${planned.category} ${planned.fileName}`
                );
                continue;
              }
              docsToSave.push({
                category: planned.category,
                fileName: hit.fileName || planned.fileName,
                base64: hit.base64,
              });
            }

            part.matched = docsToSave.length;
            if (docsToSave.length === 0) {
              totals.workersSkippedNoMatch += 1;
              console.log(`  [skip]  ${label}: no content matched`);
              return part;
            }

            for (const doc of docsToSave) {
              try {
                const buffer = Buffer.from(doc.base64, 'base64');
                // filePrefix = category name as given (Resume, Cover_Letter, …)
                const outcome = await saveGeneratedDocumentFile(MOCK_FTP_DIR, {
                  directoryName: doc.category,
                  filePrefix: doc.category,
                  employeeId: emp.employeeId,
                  attachmentDescriptor: doc.fileName,
                  buffer,
                });

                part.saved.push({
                  employeeId: emp.employeeId,
                  document: doc.category,
                  docCategory: doc.category,
                  path: outcome.relativePath,
                  bytes: outcome.bytes,
                  attachment: doc.fileName,
                });
                if (totals.perCategory[doc.category] != null) {
                  totals.perCategory[doc.category] += 1;
                }
                console.log(
                  `    save  ${outcome.relativePath} (${outcome.bytes} bytes)`
                );

                const remote = await uploader.upload({
                  relativePath: outcome.relativePath,
                  localPath: outcome.absolutePath,
                });
                part.uploaded.push({
                  employeeId: emp.employeeId,
                  document: doc.category,
                  docCategory: doc.category,
                  path: outcome.relativePath,
                  remotePath: remote.remotePath,
                });
                console.log(`    sftp  ${remote.remotePath}`);
              } catch (err) {
                part.errors.push({
                  employeeId: emp.employeeId,
                  document: doc.fileName,
                  error: err.message,
                });
                console.log(
                  `    error ${label} ${doc.fileName}: ${err.message}`
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
    console.log(`[${apiName}] per-category:`, totals.perCategory);
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

function normalizeLoose(name) {
  return String(name || '')
    .toLowerCase()
    .replace(/&amp;/g, '&')
    .replace(/\s+/g, '')
    .replace(/_/g, '');
}

// re-export for tests
export { classifyResumeDocument };
