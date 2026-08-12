import fs from 'node:fs/promises';
import path from 'node:path';
import { ROOT_DIR } from '../config.js';

/**
 * Build run metrics and write JSON + Markdown report files under reports/.
 */
export async function writeRunReport({
  api = 'report-info',
  mode,
  startedAt,
  finishedAt,
  durationMs,
  totals,
  pageSize,
  concurrency,
  maxPages,
}) {
  const byCategory = {};
  const byDocument = {};
  const employeesWithDocs = new Set();

  for (const item of totals.saved || []) {
    const cat = item.docCategory || 'Unknown';
    const doc = item.document || 'Unknown';
    byCategory[cat] = (byCategory[cat] || 0) + 1;
    const docKey = `${cat}::${doc}`;
    byDocument[docKey] = (byDocument[docKey] || 0) + 1;
    if (item.employeeId) employeesWithDocs.add(String(item.employeeId));
  }

  const byDocumentTable = Object.entries(byDocument)
    .map(([key, count]) => {
      const [category, document] = key.split('::');
      return { category, document, count };
    })
    .sort((a, b) => b.count - a.count || a.category.localeCompare(b.category));

  const employeeOutcomes = Array.isArray(totals.employeeOutcomes)
    ? totals.employeeOutcomes
    : [];
  const notUploaded = employeeOutcomes.filter((o) => o.outcome !== 'uploaded');
  const notUploadedByReason = {};
  for (const o of notUploaded) {
    const key = o.outcome || 'unknown';
    if (!notUploadedByReason[key]) {
      notUploadedByReason[key] = {
        outcome: key,
        count: 0,
        reason: o.reason || key,
        sampleEmployeeIds: [],
      };
    }
    const bucket = notUploadedByReason[key];
    bucket.count += 1;
    if (bucket.sampleEmployeeIds.length < 25 && o.employeeId) {
      bucket.sampleEmployeeIds.push(String(o.employeeId));
    }
    // Prefer a stable descriptive reason text
    if (o.reason && o.reason.length > (bucket.reason?.length || 0)) {
      bucket.reason = o.reason;
    }
  }

  const report = {
    api,
    mode,
    startedAt,
    finishedAt,
    duration: {
      ms: durationMs,
      seconds: Math.round(durationMs / 1000),
      human: formatDuration(durationMs),
    },
    config: {
      pageSize,
      concurrency,
      maxPages: maxPages ?? null,
    },
    employees: {
      inWidsReport: totals.employeesInWidsReport ?? null,
      withAllowListedDocs: totals.employeesWithAllowListedDocs ?? null,
      skippedNoAllowListedDocs: totals.workersSkippedNoMatch ?? 0,
      processed: totals.workersProcessed ?? 0,
      withSavedDocuments: employeesWithDocs.size,
      failedWorkers: (totals.workerErrors || []).length,
    },
    documents: {
      totalParsedGroups: totals.parsed ?? 0,
      matchedAllowList: totals.matched ?? 0,
      skippedNotAllowListed: totals.skippedFilter ?? 0,
      saved: (totals.saved || []).length,
      uploaded: (totals.uploaded || []).length,
      saveErrors: (totals.errors || []).length,
      byCategory,
      byDocument: byDocumentTable,
    },
    batches: totals.pages ?? 0,
    workerErrors: (totals.workerErrors || []).slice(0, 100),
    // Personal (and any API that sets employeeOutcomes): why not uploaded
    notUploadedSummary: totals.notUploadedSummary ?? null,
    notUploadedByReason: Object.values(notUploadedByReason).sort(
      (a, b) => b.count - a.count
    ),
    earlyStop: totals.earlyStop ?? null,
    // Full list can be large on full population runs; keep in JSON, summarize in MD
    employeeOutcomes,
    notUploadedEmployees: notUploaded,
  };

  const reportsDir = path.join(ROOT_DIR, 'reports');
  await fs.mkdir(reportsDir, { recursive: true });

  const stamp = startedAt.replace(/[:.]/g, '-');
  const baseName = `${api}-${mode}-${stamp}`;
  const jsonPath = path.join(reportsDir, `${baseName}.json`);
  const mdPath = path.join(reportsDir, `${baseName}.md`);
  const latestJson = path.join(reportsDir, `${api}-latest.json`);
  const latestMd = path.join(reportsDir, `${api}-latest.md`);

  const md = toMarkdown(report);

  await fs.writeFile(jsonPath, JSON.stringify(report, null, 2), 'utf8');
  await fs.writeFile(mdPath, md, 'utf8');
  await fs.writeFile(latestJson, JSON.stringify(report, null, 2), 'utf8');
  await fs.writeFile(latestMd, md, 'utf8');

  console.log(`[report-info] report written: ${mdPath}`);
  console.log(`[report-info] report written: ${jsonPath}`);
  console.log(`[report-info] also: ${latestMd}`);

  return { report, jsonPath, mdPath };
}

function toMarkdown(r) {
  const catLines = Object.entries(r.documents.byCategory)
    .sort((a, b) => b[1] - a[1])
    .map(([cat, n]) => `| ${cat} | ${n} |`)
    .join('\n');

  const docLines = r.documents.byDocument
    .map((d) => `| ${d.category} | ${d.document} | ${d.count} |`)
    .join('\n');

  return `# Workday ${r.api} run

## Summary

| Field | Value |
|-------|-------|
| API | ${r.api} |
| Mode | ${r.mode} |
| Started | ${r.startedAt} |
| Finished | ${r.finishedAt} |
| **Duration** | **${r.duration.human}** (${r.duration.seconds}s) |
| Page size | ${r.config.pageSize} |
| Concurrency | ${r.config.concurrency} |
| Max pages | ${r.config.maxPages ?? 'all'} |
| Batches completed | ${r.batches} |

## Employees

| Metric | Count |
|--------|------:|
| In WIDs-only report | ${r.employees.inWidsReport ?? 'n/a'} |
| With allow-listed docs (eligible) | ${r.employees.withAllowListedDocs ?? 'n/a'} |
| Skipped (no allow-listed docs) | ${r.employees.skippedNoAllowListedDocs} |
| **Processed** | **${r.employees.processed}** |
| With at least one saved document | ${r.employees.withSavedDocuments} |
| Failed workers | ${r.employees.failedWorkers} |

## Documents

| Metric | Count |
|--------|------:|
| Document groups parsed | ${r.documents.totalParsedGroups} |
| Matched allow-list | ${r.documents.matchedAllowList} |
| Skipped (not allow-listed) | ${r.documents.skippedNotAllowListed} |
| **Saved** | **${r.documents.saved}** |
| **Uploaded (SFTP)** | **${r.documents.uploaded}** |
| Save/SFTP errors | ${r.documents.saveErrors} |

## Documents per category

| Category | Documents saved |
|----------|----------------:|
${catLines || '| (none) | 0 |'}

## Documents per document type

| Category | Document | Count |
|----------|----------|------:|
${docLines || '| (none) | (none) | 0 |'}

## Why employees were not uploaded

${formatNotUploadedSection(r)}

## Worker errors (first 100)

${
  r.workerErrors.length
    ? r.workerErrors
        .map((e) => `- emp=${e.employeeId ?? '?'} wid=${e.wid}: ${e.error}`)
        .join('\n')
    : '_None_'
}
`;
}

function formatNotUploadedSection(r) {
  const byReason = r.notUploadedByReason || [];
  if (!byReason.length && !(r.employeeOutcomes || []).length) {
    return '_No per-employee outcome data for this API (only **personal** records skip reasons today)._';
  }

  const uploadedCount = (r.employeeOutcomes || []).filter(
    (o) => o.outcome === 'uploaded'
  ).length;
  const notCount = (r.notUploadedEmployees || []).length;

  const lines = [];
  lines.push(
    `Employees with outcome recorded: **${(r.employeeOutcomes || []).length}** (uploaded: **${uploadedCount}**, not uploaded: **${notCount}**)`
  );
  lines.push('');

  if (r.earlyStop) {
    lines.push('### Early stop');
    lines.push('');
    lines.push(
      `Stopped after scanning **${r.earlyStop.scannedThroughIndex}** of **${r.earlyStop.totalInList}** list employees. ` +
        `**${r.earlyStop.notScannedCount}** remaining were not called (majorsFull=${r.earlyStop.majorsFull}, ` +
        `categoriesAtCap=${r.earlyStop.categoriesAtCap}, no new category for ${r.earlyStop.consecutiveNoNewCategory} employees).`
    );
    lines.push('');
  }

  lines.push('### Summary by reason');
  lines.push('');
  lines.push('| Outcome code | Count | Reason |');
  lines.push('|--------------|------:|--------|');
  for (const row of byReason) {
    const reason = String(row.reason || row.outcome).replace(/\|/g, '\\|');
    lines.push(`| ${row.outcome} | ${row.count} | ${reason} |`);
  }
  if (!byReason.length) {
    lines.push('| (none) | 0 | — |');
  }
  lines.push('');

  lines.push('### Sample employee IDs per reason (up to 25)');
  lines.push('');
  for (const row of byReason) {
    lines.push(`#### \`${row.outcome}\` (${row.count})`);
    lines.push('');
    lines.push(row.reason || '');
    lines.push('');
    if (row.sampleEmployeeIds?.length) {
      lines.push('```');
      lines.push(row.sampleEmployeeIds.join(', '));
      lines.push('```');
    } else {
      lines.push('_No employee IDs_');
    }
    lines.push('');
  }

  lines.push(
    '_Full per-employee list (including all IDs and detail) is in the JSON report under `notUploadedEmployees` / `employeeOutcomes`._'
  );
  return lines.join('\n');
}

function formatDuration(ms) {
  const totalSec = Math.floor(ms / 1000);
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = totalSec % 60;
  if (h > 0) return `${h}h ${m}m ${s}s`;
  if (m > 0) return `${m}m ${s}s`;
  return `${s}s`;
}
