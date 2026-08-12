import { MOCK_FTP_DIR, getWorkdayConfig, getBlobitoryConfig, buildRaasUrl, buildStaffingUrl } from '../config.js';
import { fetchWorkersReport } from '../lib/workday-client.js';
import { fetchWorkerDocumentsSoap } from '../lib/staffing-client.js';
import {
  parsePersonalWorkerDocumentsSoap,
  sanitizePersonalCategoryPart,
  extractEmployeeIdsFromReportXml,
  PERSONAL_EXCLUDED_CATEGORIES,
} from '../lib/personal-list.js';
import { saveGeneratedDocumentFile } from '../lib/file-saver.js';
import { FtpUploader } from '../lib/sftp-client.js';
import { mapPool } from '../lib/parallel.js';
import { writeRunReport } from '../lib/run-report.js';

/** Population sources (union of EmployeeIDs) — same approach as category scan */
const LIST_REPORTS = ['CR_Export_Certification_-_Copy', 'API_Review_Document_-_Copy', 'API_Education'];

/**
 * personal — Staffing Worker Documents by Workday-owned category
 *
 * Requirements lines 1383–1444:
 *   1. Staffing Get_Workers (Include_Worker_Documents)
 *   2. Category = Document_Category__Workday_Owned__ID
 *   3. Exclude CERT, LICENSES, EDUCATION
 *   4. Skip docs with no Workday_Owned category
 *   5. Personal/100_{EmployeeID}_{Category}_{FilenameNoSpaces}
 *   6. SFTP /ROI/Workday/
 *
 * Default run: first N employees **per category** (N = maxEmployees, default 10).
 *
 * Example:
 *   Personal/100_49494_BENEFITS_Divorce.pdf
 */
export async function runPersonal(options = {}) {
  const {
    mock = false,
    pageSize = 5, // unused (per-employee staffing); kept for CLI compatibility
    maxPages = null,
    maxEmployees = 10, // max employees **per category**
    concurrency = 5,
  } = options;

  const apiName = 'personal';
  const directoryName = 'Personal';
  const perCategoryLimit =
    maxEmployees != null && maxEmployees > 0 ? maxEmployees : 10;
  const startedAt = new Date().toISOString();
  const startedMs = Date.now();

  console.log(
    `[${apiName}] mode=${mock ? 'mock' : 'live'} concurrency=${concurrency} ` +
      `maxEmployeesPerCategory=${perCategoryLimit}`
  );
  console.log(`[${apiName}] local output: ${MOCK_FTP_DIR}`);
  console.log(`[${apiName}] started: ${startedAt}`);
  console.log(
    `[${apiName}] path: Personal/100_{EmployeeID}_{Workday_Owned_ID}_{Filename}`
  );
  console.log(
    `[${apiName}] excluded categories: ${[...PERSONAL_EXCLUDED_CATEGORIES].join(', ')}`
  );
  console.log(
    `[${apiName}] skip documents with no Document_Category__Workday_Owned__ID`
  );

  /** categoryOwnedId (upper) → Set of employeeIds already counted */
  const employeesByCategory = new Map();
  /** categoryOwnedId (display) → upload count */
  const uploadsByCategory = new Map();

  /**
   * Per-employee outcomes for the report (why not uploaded).
   * @type {Array<{ employeeId: string, outcome: string, reason: string, detail?: object }>}
   */
  const employeeOutcomes = [];
  /** @type {Map<string, number>} */
  const outcomeCounts = new Map();

  const recordOutcome = (employeeId, outcome, reason, detail = undefined) => {
    const row = { employeeId: String(employeeId), outcome, reason };
    if (detail && Object.keys(detail).length) row.detail = detail;
    employeeOutcomes.push(row);
    outcomeCounts.set(outcome, (outcomeCounts.get(outcome) || 0) + 1);
  };

  const totals = {
    parsed: 0,
    matched: 0,
    skippedFilter: 0,
    skippedNoCategory: 0,
    skippedExcluded: 0,
    skippedQuota: 0,
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
    employeesByCategory: {},
    /** filled in finally for report */
    employeeOutcomes: [],
    notUploadedSummary: {},
    earlyStop: null,
  };

  const staffingUrl =
    process.env.WORKDAY_STAFFING_URL || buildStaffingUrl();

  try {
    if (mock) {
      throw new Error(
        'personal --mock true is not implemented. Use --mock false.'
      );
    }

    const wd = getWorkdayConfig();
    const blob = getBlobitoryConfig();
    const staffingUser =
      process.env.WORKDAY_STAFFING_USERNAME || blob.username;
    const staffingPassword =
      process.env.WORKDAY_STAFFING_PASSWORD ||
      blob.password ||
      wd.password;

    // --- step 1: employee population ---
    console.log(`[${apiName}] step 1/2: load employee ID lists (union)`);
    const allIds = new Set();
    const listUrls = process.env.WORKDAY_PERSONAL_LIST_URL
      ? [process.env.WORKDAY_PERSONAL_LIST_URL]
      : LIST_REPORTS.map((r) => buildRaasUrl(r));

    for (const url of listUrls) {
      console.log(`[${apiName}]   ${url}`);
      try {
        const body = await fetchWorkersReport({
          workersReportUrl: withFormatXml(url),
          username: wd.username,
          password: wd.password,
          timeoutMs: 15 * 60 * 1000,
        });
        const ids = extractEmployeeIdsFromReportXml(body);
        console.log(`[${apiName}]   extracted ${ids.length} EmployeeIDs`);
        for (const id of ids) allIds.add(id);
      } catch (err) {
        console.error(`[${apiName}]   list failed: ${err.message}`);
      }
    }

    let employeeIds = [...allIds].sort((a, b) =>
      String(a).localeCompare(String(b), undefined, { numeric: true })
    );
    totals.employeesInWidsReport = employeeIds.length;

    // Optional hard cap on how far into the population we scan
    // (maxPages * pageSize if both set — otherwise full list until quotas filled)
    if (maxPages != null && maxPages > 0 && pageSize > 0) {
      const scanCap = maxPages * pageSize;
      employeeIds = employeeIds.slice(0, scanCap);
      console.log(
        `[${apiName}] scan cap from maxPages*pageSize: ${employeeIds.length}`
      );
    }

    console.log(
      `[${apiName}] unique employees: ${totals.employeesInWidsReport}; ` +
        `will scan until ${perCategoryLimit} employees per allowed category ` +
        `(or population exhausted)`
    );

    // --- step 2: Get_Workers + upload with per-category employee quota ---
    console.log(
      `[${apiName}] step 2/2: Staffing Get_Workers → filter categories → SFTP`
    );
    console.log(`[${apiName}]   ${staffingUrl}`);

    const uploader = new FtpUploader();
    // Shared mutable stop: once every *seen* category is full we still continue
    // briefly to discover rare categories; we stop only when the list ends OR
    // optional early-stop after long stretch with no new category + all full.
    let consecutiveNoNewCategory = 0;
    /** Stop after this many employees with no newly discovered category. */
    const EARLY_STOP_AFTER_NO_NEW = 500;
    /**
     * High-volume categories that should reach the per-category employee cap
     * before we consider early-stop (rare categories often have < 10 people total).
     */
    const MAJOR_CATEGORIES = [
      'OTHER_DOCUMENTS',
      'BENEFITS',
      'BACKGROUND CHECK',
      'OFFERS',
      'PERSONAL_INFORMATION',
    ];
    /** Index of first employee not scanned due to early stop (null if full scan). */
    let earlyStopFromIndex = null;
    let earlyStopMeta = null;

    try {
      await uploader.connect();

      // Process in batches for progress logging; concurrency within batch
      const batchSize = Math.max(concurrency * 2, 10);
      for (let offset = 0; offset < employeeIds.length; offset += batchSize) {
        const batch = employeeIds.slice(offset, offset + batchSize);
        totals.pages += 1;
        console.log(
          `[${apiName}] batch ${totals.pages} ` +
            `(emps ${offset + 1}-${offset + batch.length} of ${employeeIds.length}, ` +
            `concurrency=${concurrency})`
        );

        const batchResults = await mapPool(batch, concurrency, async (employeeId) => {
          totals.workersProcessed += 1;
          const label = `emp=${employeeId}`;
          const part = {
            employeeId: String(employeeId),
            parsed: 0,
            matched: 0,
            skippedFilter: 0,
            skippedNoCategory: 0,
            skippedExcluded: 0,
            skippedQuota: 0,
            quotaCategories: [],
            saved: [],
            skipped: [],
            errors: [],
            uploaded: [],
            discoveredCategories: [],
            outcome: null,
            reason: null,
            detail: null,
          };

          try {
            const soapXml = await fetchWorkerDocumentsSoap({
              employeeId,
              username: staffingUser,
              password: staffingPassword,
              staffingUrl,
            });

            const {
              workerId,
              documents,
              skippedNoCategory,
              skippedExcluded,
            } = parsePersonalWorkerDocumentsSoap(soapXml);

            part.skippedNoCategory = skippedNoCategory;
            part.skippedExcluded = skippedExcluded;
            part.parsed = documents.length + skippedNoCategory + skippedExcluded;
            part.matched = documents.length;

            if (documents.length === 0) {
              totals.workersSkippedNoMatch += 1;
              const outcomeInfo = classifyNoEligibleDocs({
                skippedNoCategory,
                skippedExcluded,
              });
              part.outcome = outcomeInfo.outcome;
              part.reason = outcomeInfo.reason;
              part.detail = {
                skippedNoCategory,
                skippedExcluded,
                eligibleDocuments: 0,
              };
              return part;
            }

            const workerKey = workerId || employeeId;

            // Group docs by category; decide quota before uploading
            const byCat = new Map();
            for (const doc of documents) {
              const key = doc.categoryOwnedId.toUpperCase();
              if (!byCat.has(key)) byCat.set(key, []);
              byCat.get(key).push(doc);
            }

            for (const [catKey, docs] of byCat) {
              const displayCat = docs[0].categoryOwnedId;
              if (!employeesByCategory.has(catKey)) {
                employeesByCategory.set(catKey, new Set());
                part.discoveredCategories.push(displayCat);
              }
              const empSet = employeesByCategory.get(catKey);
              const alreadyCounted = empSet.has(workerKey);
              if (!alreadyCounted && empSet.size >= perCategoryLimit) {
                part.skippedQuota += docs.length;
                part.quotaCategories.push(displayCat);
                continue;
              }

              // Count this employee for the category once we attempt upload
              empSet.add(workerKey);

              for (const doc of docs) {
                try {
                  const filePrefix = sanitizePersonalCategoryPart(
                    doc.categoryOwnedId
                  );
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
                    document: doc.categoryOwnedId,
                    docCategory: doc.categoryOwnedId,
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
                    document: doc.categoryOwnedId,
                    docCategory: doc.categoryOwnedId,
                    path: outcome.relativePath,
                    remotePath: remote.remotePath,
                  });
                  uploadsByCategory.set(
                    displayCat,
                    (uploadsByCategory.get(displayCat) || 0) + 1
                  );
                  console.log(`    sftp  ${remote.remotePath}`);
                } catch (err) {
                  part.errors.push({
                    employeeId: workerKey,
                    document: doc.filename,
                    category: doc.categoryOwnedId,
                    error: err.message,
                  });
                  console.error(
                    `    error ${label} ${doc.categoryOwnedId}/${doc.filename}: ${err.message}`
                  );
                }
              }
            }

            if (part.saved.length > 0) {
              part.outcome = 'uploaded';
              part.reason =
                part.skippedQuota > 0
                  ? `Uploaded ${part.uploaded.length} file(s); ${part.skippedQuota} document(s) skipped because category employee cap (${perCategoryLimit}) was already met`
                  : `Uploaded ${part.uploaded.length} file(s) to SFTP`;
              part.detail = {
                filesUploaded: part.uploaded.length,
                skippedQuotaDocuments: part.skippedQuota,
                quotaCategories: part.quotaCategories,
                skippedNoCategory,
                skippedExcluded,
              };
              console.log(
                `  [done]  ${label}: saved=${part.saved.length} ` +
                  `uploaded=${part.uploaded.length} quotaSkip=${part.skippedQuota} ` +
                  `errors=${part.errors.length}`
              );
            } else if (part.errors.length > 0 && part.skippedQuota === 0) {
              part.outcome = 'save_or_sftp_error';
              part.reason = `Eligible documents found but save/SFTP failed: ${part.errors[0].error}`;
              part.detail = {
                errorCount: part.errors.length,
                errors: part.errors.slice(0, 5),
              };
            } else if (part.skippedQuota > 0) {
              part.outcome = 'category_quota_full';
              part.reason =
                `Not uploaded: all eligible categories already had ${perCategoryLimit} employees ` +
                `(sample cap). Categories at cap for this worker: ${[...new Set(part.quotaCategories)].join(', ') || 'n/a'}`;
              part.detail = {
                eligibleDocuments: documents.length,
                skippedQuotaDocuments: part.skippedQuota,
                quotaCategories: [...new Set(part.quotaCategories)],
                perCategoryLimit,
              };
            } else {
              part.outcome = 'no_files_saved';
              part.reason =
                'Eligible documents were present but nothing was saved (unexpected)';
              part.detail = {
                eligibleDocuments: documents.length,
                skippedNoCategory,
                skippedExcluded,
              };
            }
          } catch (err) {
            part.errors.push({ employeeId, error: err.message });
            totals.workerErrors.push({ employeeId, error: err.message });
            part.outcome = 'staffing_error';
            part.reason = summarizeStaffingError(err.message);
            part.detail = { error: err.message };
            console.error(`  [error] ${label}: ${err.message}`);
          }

          return part;
        });

        let batchDiscovered = 0;
        for (const part of batchResults) {
          totals.parsed += part.parsed;
          totals.matched += part.matched;
          totals.skippedFilter += part.skippedFilter;
          totals.skippedNoCategory += part.skippedNoCategory || 0;
          totals.skippedExcluded += part.skippedExcluded || 0;
          totals.skippedQuota += part.skippedQuota || 0;
          totals.saved.push(...part.saved);
          totals.skipped.push(...part.skipped);
          totals.errors.push(...part.errors);
          totals.uploaded.push(...part.uploaded);
          batchDiscovered += (part.discoveredCategories || []).length;

          if (part.outcome) {
            recordOutcome(
              part.employeeId,
              part.outcome,
              part.reason || part.outcome,
              part.detail
            );
          }
        }

        if (batchDiscovered === 0) consecutiveNoNewCategory += batch.length;
        else consecutiveNoNewCategory = 0;

        // Progress: employees per category
        const catSummary = [...employeesByCategory.entries()]
          .map(([k, set]) => `${k}=${set.size}/${perCategoryLimit}`)
          .sort()
          .join(' ');
        console.log(
          `[${apiName}] progress categories: ${catSummary || '(none yet)'}`
        );
        console.log(
          `[${apiName}] totals saved=${totals.saved.length} uploaded=${totals.uploaded.length} ` +
            `errors=${totals.errors.length} quotaSkip=${totals.skippedQuota}`
        );

        // Early stop: majors filled (or enough categories seen) + no new category for a while.
        // Rare categories with <10 people in the tenant never hit the cap — do not require them.
        const majorsFull = MAJOR_CATEGORIES.every(
          (c) => (employeesByCategory.get(c)?.size || 0) >= perCategoryLimit
        );
        const fullCount = [...employeesByCategory.values()].filter(
          (s) => s.size >= perCategoryLimit
        ).length;
        if (
          consecutiveNoNewCategory >= EARLY_STOP_AFTER_NO_NEW &&
          (majorsFull || fullCount >= 8)
        ) {
          earlyStopFromIndex = offset + batch.length;
          earlyStopMeta = {
            consecutiveNoNewCategory,
            categoriesSeen: employeesByCategory.size,
            categoriesAtCap: fullCount,
            majorsFull,
            perCategoryLimit,
            scannedThroughIndex: earlyStopFromIndex,
            totalInList: employeeIds.length,
            notScannedCount: Math.max(
              0,
              employeeIds.length - earlyStopFromIndex
            ),
          };
          console.log(
            `[${apiName}] early stop: no new category in ${consecutiveNoNewCategory} employees; ` +
              `categories=${employeesByCategory.size} atCap=${fullCount} majorsFull=${majorsFull}`
          );
          break;
        }
      }

      // Employees never scanned because of early stop
      if (earlyStopFromIndex != null && earlyStopFromIndex < employeeIds.length) {
        const notScanned = employeeIds.slice(earlyStopFromIndex);
        const reason =
          `Not scanned: early stop after major categories reached ${perCategoryLimit} employees ` +
          `and no new category appeared for ${earlyStopMeta?.consecutiveNoNewCategory ?? EARLY_STOP_AFTER_NO_NEW} employees ` +
          `(sample mode). ${notScanned.length} employee(s) remaining in list were not called.`;
        for (const id of notScanned) {
          recordOutcome(id, 'early_stop_not_scanned', reason, {
            ...earlyStopMeta,
          });
        }
        totals.earlyStop = earlyStopMeta;
      }
    } finally {
      await uploader.end();
    }
  } finally {
    for (const [cat, set] of employeesByCategory) {
      totals.employeesByCategory[cat] = set.size;
    }
    totals.employeesWithAllowListedDocs = Object.keys(
      totals.employeesByCategory
    ).length;

    totals.employeeOutcomes = employeeOutcomes;
    totals.notUploadedSummary = Object.fromEntries(outcomeCounts);
    totals.uploadsByCategory = Object.fromEntries(uploadsByCategory);

    const finishedAt = new Date().toISOString();
    const durationMs = Date.now() - startedMs;
    console.log(
      `[${apiName}] done. employeesScanned=${totals.workersProcessed} ` +
        `saved=${totals.saved.length} uploaded=${totals.uploaded.length} ` +
        `errors=${totals.errors.length} workerErrors=${totals.workerErrors.length} ` +
        `duration=${Math.round(durationMs / 1000)}s`
    );
    console.log(
      `[${apiName}] employees per category: ${JSON.stringify(totals.employeesByCategory)}`
    );
    console.log(
      `[${apiName}] uploads per category: ${JSON.stringify(Object.fromEntries(uploadsByCategory))}`
    );
    console.log(
      `[${apiName}] outcomes: ${JSON.stringify(totals.notUploadedSummary)}`
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
  if (url.includes('format=')) return url;
  return `${url}${url.includes('?') ? '&' : '?'}format=xml`;
}

/**
 * Classify employees who returned zero eligible Personal documents.
 */
function classifyNoEligibleDocs({ skippedNoCategory, skippedExcluded }) {
  if (skippedExcluded > 0 && skippedNoCategory === 0) {
    return {
      outcome: 'only_excluded_categories',
      reason:
        'Not uploaded: worker documents were only in excluded categories (CERT, LICENSES, and/or EDUCATION)',
    };
  }
  if (skippedNoCategory > 0 && skippedExcluded === 0) {
    return {
      outcome: 'only_missing_workday_owned_category',
      reason:
        'Not uploaded: documents had no Document_Category__Workday_Owned__ID (tenant/custom categories only, e.g. Onboarding)',
    };
  }
  if (skippedNoCategory > 0 && skippedExcluded > 0) {
    return {
      outcome: 'no_eligible_after_filters',
      reason:
        'Not uploaded: documents were only excluded (CERT/LICENSES/EDUCATION) and/or missing Workday-owned category',
    };
  }
  return {
    outcome: 'no_worker_documents',
    reason:
      'Not uploaded: Staffing returned no worker document files with content for this employee',
  };
}

function summarizeStaffingError(message) {
  const text = String(message || '');
  const m = text.match(/'([^']+)' is not a valid ID value for type = 'Employee_ID'/i);
  if (m) {
    return `Not uploaded: Staffing rejected Employee_ID '${m[1]}' (not a valid ID for Get_Workers)`;
  }
  if (/Invalid ID value/i.test(text)) {
    return 'Not uploaded: Staffing validation error (invalid Employee_ID)';
  }
  return `Not uploaded: Staffing Get_Workers failed — ${text.slice(0, 180)}`;
}
