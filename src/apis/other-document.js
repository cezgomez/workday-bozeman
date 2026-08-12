import { MOCK_FTP_DIR, getWorkdayConfig, getBlobitoryConfig, buildRaasUrl, buildRecruitingUrl } from '../config.js';
import { fetchWorkersReport } from '../lib/workday-client.js';
import { fetchCandidateAttachmentsSoap } from '../lib/recruiting-client.js';
import {
  OTHER_DOCUMENT_CRITERIA,
  CRITERIA_NAMING,
  parseCandidateFromWorkerList,
  parseCandidateAttachmentsSoap,
} from '../lib/other-document-list.js';
import { saveGeneratedDocumentFile } from '../lib/file-saver.js';
import { FtpUploader } from '../lib/sftp-client.js';
import { mapPool } from '../lib/parallel.js';
import { writeRunReport } from '../lib/run-report.js';
import { chunkPages } from '../lib/worker-pager.js';

const LIST_REPORT = 'API_Candidate_from_Worker';

/**
 * other-document — Candidate attachments classified into Other Document directories
 *
 * Requirements lines 633–716:
 *   1. API_Candidate_from_Worker → Employee_ID + Candidate_ID
 *   2. Recruiting Get_Candidate_Attachments(Candidate_ID) → File_Content base64
 *   3. Classify into Background Check / Reference / Skill Survey / Exclusion Check
 *   4. {Criteria}/100_{EmployeeId}_{CriteriaNoSpaces}_{FilenameNoSpaces}
 *   5. SFTP /ROI/Workday/
 *
 * Example:
 *   Exclusion_Check/100_43721_ExclusionCheck_Shannon.Dejong.EC.pdf
 */
export async function runOtherDocument(options = {}) {
  const {
    mock = false,
    pageSize = 5,
    maxPages = null,
    maxEmployees = 20,
    concurrency = 5,
  } = options;

  const apiName = 'other-document';
  const startedAt = new Date().toISOString();
  const startedMs = Date.now();
  const maxEmp = maxEmployees ?? 20;

  console.log(
    `[${apiName}] mode=${mock ? 'mock' : 'live'} pageSize=${pageSize} ` +
      `concurrency=${concurrency} maxEmployeesPerCriteria=${maxEmp}`
  );
  console.log(`[${apiName}] local output: ${MOCK_FTP_DIR}`);
  console.log(`[${apiName}] started: ${startedAt}`);
  console.log(
    `[${apiName}] criteria directories: ${OTHER_DOCUMENT_CRITERIA.join(' | ')}`
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
    perCriteria: Object.fromEntries(
      OTHER_DOCUMENT_CRITERIA.map((c) => [
        c,
        { employeesSelected: 0, saved: 0, uploaded: 0, errors: 0 },
      ])
    ),
  };

  /** @type {Map<string, Set<string>>} criteria → employeeIds selected (cap maxEmp) */
  const selectedByCriteria = new Map(
    OTHER_DOCUMENT_CRITERIA.map((c) => [c, new Set()])
  );

  const listUrl = process.env.WORKDAY_OTHER_DOCUMENT_LIST_URL || buildRaasUrl(LIST_REPORT);
  const recruitingUrl =
    process.env.WORKDAY_RECRUITING_URL || buildRecruitingUrl();

  try {
    if (mock) {
      throw new Error(
        'other-document --mock true is not implemented. Use --mock false.'
      );
    }

    const wd = getWorkdayConfig();
    const blob = getBlobitoryConfig();
    const soapUser = process.env.WORKDAY_RECRUITING_USERNAME || blob.username;
    const soapPassword =
      process.env.WORKDAY_RECRUITING_PASSWORD || blob.password || wd.password;

    console.log(`[${apiName}] step 1/2: load Employee + Candidate_ID list`);
    console.log(`[${apiName}]   ${listUrl}`);
    const listBody = await fetchWorkersReport({
      workersReportUrl: withFormatXml(listUrl),
      username: wd.username,
      password: wd.password,
      timeoutMs: 10 * 60 * 1000,
    });
    console.log(`[${apiName}] list response received (${listBody.length} chars)`);

    const allRows = parseCandidateFromWorkerList(listBody);
    totals.employeesInWidsReport = allRows.length;

    // Deduplicate by employeeId (keep first candidate id)
    const byEmp = new Map();
    for (const row of allRows) {
      if (!byEmp.has(row.employeeId)) byEmp.set(row.employeeId, row);
    }
    const employees = [...byEmp.values()];
    console.log(
      `[${apiName}] list rows=${allRows.length}; unique employees=${employees.length}`
    );

    // Scan candidates until each criteria has up to maxEmp employees (or list ends).
    // Skill Survey files appear later in the list (often under ASSESSMENT category).
    const maxProbe = employees.length;
    const probeList = employees.slice(0, maxProbe);
    console.log(
      `[${apiName}] step 2/2: Recruiting attachments → classify → SFTP ` +
        `(target ${maxEmp} employees per criteria; probe up to ${probeList.length})`
    );
    console.log(`[${apiName}]   ${recruitingUrl}`);

    const processedEmployees = new Set();
    const uploader = new FtpUploader();

    function criteriaNeedsMore() {
      return OTHER_DOCUMENT_CRITERIA.some(
        (c) => selectedByCriteria.get(c).size < maxEmp
      );
    }

    try {
      await uploader.connect();

      const pages = chunkPages(probeList, pageSize);
      const pageLimit =
        maxPages != null ? Math.min(pages.length, maxPages) : pages.length;

      for (let p = 0; p < pageLimit && criteriaNeedsMore(); p++) {
        const page = pages[p];
        totals.pages += 1;
        const remaining = OTHER_DOCUMENT_CRITERIA.map(
          (c) => `${c}=${selectedByCriteria.get(c).size}/${maxEmp}`
        ).join(', ');
        console.log(
          `[${apiName}] batch ${p + 1}/${pageLimit} ` +
            `(${page.length} candidate(s); slots ${remaining})`
        );

        const batchResults = await mapPool(page, concurrency, async (emp) => {
          const label = `emp=${emp.employeeId} cand=${emp.candidateId}`;
          const part = {
            employeeId: emp.employeeId,
            candidateId: emp.candidateId,
            matched: false,
            parsed: 0,
            saved: [],
            uploaded: [],
            errors: [],
            skippedFilter: 0,
            acceptedCriteria: [],
          };

          try {
            console.log(`  [start] ${label}`);
            const soapXml = await fetchCandidateAttachmentsSoap({
              candidateId: emp.candidateId,
              username: soapUser,
              password: soapPassword,
              recruitingUrl,
            });

            const docs = parseCandidateAttachmentsSoap(soapXml);
            part.parsed = docs.length;
            const matched = docs.filter((d) => d.criteria);
            part.skippedFilter = docs.length - matched.length;

            if (matched.length === 0) {
              console.log(
                `  [skip]  ${label}: ${docs.length} attachment(s), 0 matching criteria`
              );
              return part;
            }

            // Only keep docs for criteria that still need employees, or for
            // employees already selected under that criteria.
            const toSave = matched.filter((d) => {
              const set = selectedByCriteria.get(d.criteria);
              if (!set) return false;
              if (set.has(emp.employeeId)) return true;
              return set.size < maxEmp;
            });

            if (toSave.length === 0) {
              console.log(
                `  [skip]  ${label}: matching docs exist but criteria slots full`
              );
              return part;
            }

            part.matched = true;
            console.log(
              `  [match] ${label}: saving ${toSave.length} of ${matched.length} matching`
            );

            for (const doc of toSave) {
              const naming = CRITERIA_NAMING[doc.criteria];
              if (!naming) continue;

              // Reserve employee slot for this criteria
              const set = selectedByCriteria.get(doc.criteria);
              if (!set.has(emp.employeeId) && set.size >= maxEmp) continue;
              set.add(emp.employeeId);

              try {
                const buffer = Buffer.from(doc.fileBase64, 'base64');
                const outcome = await saveGeneratedDocumentFile(MOCK_FTP_DIR, {
                  directoryName: naming.directoryName,
                  filePrefix: naming.filePrefix,
                  employeeId: emp.employeeId,
                  attachmentDescriptor: doc.filename,
                  buffer,
                });

                part.saved.push({
                  employeeId: emp.employeeId,
                  document: doc.criteria,
                  docCategory: doc.criteria,
                  path: outcome.relativePath,
                  bytes: outcome.bytes,
                  attachment: doc.filename,
                });
                part.acceptedCriteria.push(doc.criteria);
                console.log(
                  `    save  ${outcome.relativePath} (${outcome.bytes} bytes)`
                );

                const remote = await uploader.upload({
                  relativePath: outcome.relativePath,
                  localPath: outcome.absolutePath,
                });
                part.uploaded.push({
                  employeeId: emp.employeeId,
                  document: doc.criteria,
                  docCategory: doc.criteria,
                  path: outcome.relativePath,
                  remotePath: remote.remotePath,
                });
                console.log(`    sftp  ${remote.remotePath}`);

                if (totals.perCriteria[doc.criteria]) {
                  totals.perCriteria[doc.criteria].saved += 1;
                  totals.perCriteria[doc.criteria].uploaded += 1;
                }
              } catch (err) {
                part.errors.push({
                  employeeId: emp.employeeId,
                  document: doc.criteria,
                  error: err.message,
                });
                console.log(
                  `    error ${label} ${doc.criteria}: ${err.message}`
                );
                if (totals.perCriteria[doc.criteria]) {
                  totals.perCriteria[doc.criteria].errors += 1;
                }
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
          if (!part) continue;
          totals.parsed += part.parsed || 0;
          totals.skippedFilter += part.skippedFilter || 0;
          totals.errors.push(...(part.errors || []));

          if (part.matched && (part.saved || []).length > 0) {
            if (!processedEmployees.has(part.employeeId)) {
              processedEmployees.add(part.employeeId);
              totals.workersProcessed += 1;
            }
            totals.matched += (part.saved || []).length;
            totals.saved.push(...(part.saved || []));
            totals.uploaded.push(...(part.uploaded || []));
          } else {
            totals.workersSkippedNoMatch += 1;
          }
        }

        // Refresh employee counts on perCriteria
        for (const c of OTHER_DOCUMENT_CRITERIA) {
          totals.perCriteria[c].employeesSelected = selectedByCriteria.get(c).size;
        }
      }

      totals.employeesWithAllowListedDocs = processedEmployees.size;
    } finally {
      await uploader.end();
    }
  } finally {
    const finishedAt = new Date().toISOString();
    const durationMs = Date.now() - startedMs;
    console.log(
      `[${apiName}] done. matchingEmployees=${totals.workersProcessed} saved=${totals.saved.length} ` +
        `uploaded=${totals.uploaded.length} errors=${totals.errors.length} ` +
        `workerErrors=${totals.workerErrors.length} duration=${Math.round(durationMs / 1000)}s`
    );
    console.log(`[${apiName}] per-criteria results:`);
    for (const [c, s] of Object.entries(totals.perCriteria)) {
      console.log(
        `  - ${c}: employees=${s.employeesSelected ?? 0} saved=${s.saved} uploaded=${s.uploaded} errors=${s.errors}`
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
  }

  return totals;
}

function withFormatXml(url) {
  try {
    const u = new URL(url);
    if (!u.searchParams.has('format')) u.searchParams.set('format', 'xml');
    return u.toString();
  } catch {
    return url.includes('format=')
      ? url
      : `${url}${url.includes('?') ? '&' : '?'}format=xml`;
  }
}
