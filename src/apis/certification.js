import path from 'node:path';
import { MOCK_FTP_DIR, getWorkdayConfig, buildRaasUrl } from '../config.js';
import { fetchWorkersReport } from '../lib/workday-client.js';
import {
  parseCertificationListXml,
  parseCertificationDetailAndSelect,
  buildCertificationPath,
} from '../lib/certification-list.js';
import { saveBuffer } from '../lib/file-saver.js';
import { FtpUploader } from '../lib/sftp-client.js';
import { mapPool } from '../lib/parallel.js';
import { writeRunReport } from '../lib/run-report.js';
import { chunkPages } from '../lib/worker-pager.js';

const LIST_REPORT = 'CR_Export_Certification_-_Copy';

const DETAIL_REPORT = 'CR_Export_Certification';

/**
 * certification — Worker certification attachments (most-recent event rule)
 *
 * Requirements lines 1292–1578:
 *   1. CR_Export_Certification_-_Copy → EmployeeID + workdayID list
 *   2. CR_Export_Certification?Worker!WID=… → events + attachmentContent
 *   3. Per Certifications_from_Action_Event Descriptor, take the event with the
 *      most recent `completed` and all Attachments on that event
 *   4. Certification/100_{EmployeeID}_{CertDescriptorNoSpaces}_{AttachmentNoSpaces}
 *   5. SFTP /ROI/Workday/
 *
 * Example:
 *   Certification/100_49494_AmericanHeartAssociationPALS-AmericanHeartAssociation_Capture.PNG
 *
 * This is intentionally different from Personal (Staffing by category) and from
 * older CERT-only Staffing downloads.
 */
export async function runCertification(options = {}) {
  const {
    mock = false,
    pageSize = 5,
    maxPages = null,
    maxEmployees = 20,
    concurrency = 5,
  } = options;

  const apiName = 'certification';
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
    `[${apiName}] path: Certification/100_{EmployeeID}_{CertDescriptor}_{Filename}`
  );
  console.log(
    `[${apiName}] rule: most recent wd:completed per certification WID ` +
      `(same display name + different WID = separate files)`
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
  };

  const listUrl =
    process.env.WORKDAY_CERTIFICATION_LIST_URL || buildRaasUrl(LIST_REPORT);
  const detailUrl =
    process.env.WORKDAY_CERTIFICATION_DETAIL_URL || buildRaasUrl(DETAIL_REPORT);

  try {
    if (mock) {
      throw new Error(
        'certification --mock true is not implemented. Use --mock false.'
      );
    }

    const wd = getWorkdayConfig();

    console.log(`[${apiName}] step 1/2: load Certification RaaS list`);
    console.log(`[${apiName}]   ${listUrl}`);
    const listBody = await fetchWorkersReport({
      workersReportUrl: withFormatXml(listUrl),
      username: wd.username,
      password: wd.password,
      timeoutMs: 15 * 60 * 1000,
    });
    console.log(
      `[${apiName}] list response received (${listBody.length} chars)`
    );

    const employees = parseCertificationListXml(listBody);
    totals.employeesInWidsReport = employees.length;
    totals.parsed = employees.reduce((n, e) => n + e.eventCount, 0);

    // Prefer employees that already show cert events in the list report
    const withCerts = employees.filter((e) => e.certDescriptors.length > 0);
    let list = withCerts.length > 0 ? withCerts : employees;
    if (maxEmp != null && maxEmp > 0) {
      list = list.slice(0, maxEmp);
    }
    totals.employeesWithAllowListedDocs = list.length;

    console.log(
      `[${apiName}] employees in list: ${employees.length} ` +
        `(with cert events: ${withCerts.length}); processing: ${list.length}`
    );
    for (const e of list.slice(0, 3)) {
      console.log(
        `  sample emp=${e.employeeId} certs=${e.certDescriptors.length}:`,
        e.certDescriptors.slice(0, 3).join(' | ')
      );
    }

    console.log(
      `[${apiName}] step 2/2: detail RaaS per Worker!WID → most-recent files → SFTP`
    );
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
            parsed: emp.eventCount,
            matched: 0,
            skippedFilter: 0,
            saved: [],
            skipped: [],
            errors: [],
            uploaded: [],
          };

          try {
            console.log(
              `  [start] ${label} workdayID=${String(emp.workdayId).slice(0, 12)}… ` +
                `listCerts=${emp.certDescriptors.length}`
            );

            const detailBody = await fetchWorkersReport({
              workersReportUrl: detailUrlForWorker(detailUrl, emp.workdayId),
              username: wd.username,
              password: wd.password,
              timeoutMs: 5 * 60 * 1000,
            });

            const selected = parseCertificationDetailAndSelect(detailBody);
            part.matched = selected.files.length;
            totals.matched += selected.files.length;

            if (selected.files.length === 0) {
              totals.workersSkippedNoMatch += 1;
              console.log(
                `  [skip]  ${label}: no cert attachments after most-recent selection ` +
                  `(certs=${selected.certCount})`
              );
              return part;
            }

            // Disambiguate same filename under same employee+cert (different WIDs)
            const usedPaths = new Set();

            for (const doc of selected.files) {
              try {
                let relativePath = buildCertificationPath({
                  employeeId: emp.employeeId,
                  certDescriptor: doc.certDescriptor,
                  attachmentDescriptor: doc.attachmentDescriptor,
                });

                if (usedPaths.has(relativePath.toLowerCase())) {
                  relativePath = disambiguatePath(
                    relativePath,
                    doc.attachmentWid || doc.fileId || 'dup'
                  );
                }
                usedPaths.add(relativePath.toLowerCase());

                const buffer = Buffer.from(doc.base64, 'base64');
                const outcome = await saveBuffer(
                  MOCK_FTP_DIR,
                  relativePath,
                  buffer
                );

                part.saved.push({
                  employeeId: emp.employeeId,
                  document: doc.certDescriptor,
                  docCategory: 'Certification',
                  path: outcome.relativePath,
                  bytes: outcome.bytes,
                  attachment: doc.attachmentDescriptor,
                  completed: doc.completed,
                });
                console.log(
                  `    save  ${outcome.relativePath} (${outcome.bytes} bytes) ` +
                    `[${doc.completed}]`
                );

                const remote = await uploader.upload({
                  relativePath: outcome.relativePath,
                  localPath: outcome.absolutePath,
                });
                part.uploaded.push({
                  employeeId: emp.employeeId,
                  document: doc.certDescriptor,
                  docCategory: 'Certification',
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
              `  [done]  ${label}: certs=${selected.certCount} ` +
                `files=${selected.files.length} saved=${part.saved.length} ` +
                `uploaded=${part.uploaded.length} errors=${part.errors.length}`
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
            console.log(`  [error] ${label}: ${err.message}`);
          }

          return part;
        });

        for (const part of batchResults) {
          totals.saved.push(...part.saved);
          totals.skipped.push(...part.skipped);
          totals.errors.push(...part.errors);
          totals.uploaded.push(...part.uploaded);
        }

        console.log(
          `[${apiName}] totals saved=${totals.saved.length} ` +
            `uploaded=${totals.uploaded.length} errors=${totals.errors.length}`
        );
      }
    } finally {
      await uploader.end();
    }

    const finishedAt = new Date().toISOString();
    const durationMs = Date.now() - startedMs;
    console.log(
      `[${apiName}] done. processed=${totals.workersProcessed} ` +
        `saved=${totals.saved.length} uploaded=${totals.uploaded.length} ` +
        `errors=${totals.errors.length} duration=${Math.round(durationMs / 1000)}s`
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

    return totals;
  } catch (err) {
    console.error(`[${apiName}] fatal: ${err.message}`);
    throw err;
  }
}

function withFormatXml(url) {
  if (url.includes('format=')) return url;
  return `${url}${url.includes('?') ? '&' : '?'}format=xml`;
}

function detailUrlForWorker(detailUrl, workdayId) {
  const u = new URL(detailUrl);
  u.searchParams.set('format', 'xml');
  u.searchParams.set('Worker!WID', workdayId);
  return u.toString();
}

/**
 * When two different files share the same descriptor, append a short unique tag
 * before the extension so both land on SFTP.
 */
function disambiguatePath(relativePath, tag) {
  const parsed = path.parse(relativePath);
  const short = String(tag)
    .replace(/[^A-Za-z0-9]/g, '')
    .slice(-8);
  return path.join(parsed.dir, `${parsed.name}_${short}${parsed.ext}`);
}
