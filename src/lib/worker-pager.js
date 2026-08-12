import fs from 'node:fs/promises';
import { XMLParser } from 'fast-xml-parser';
import { isAllowedDocument } from './document-filter.js';

/**
 * Split an array into pages of pageSize.
 * @template T
 * @param {T[]} items
 * @param {number} pageSize
 * @returns {T[][]}
 */
export function chunkPages(items, pageSize) {
  const size = Math.max(1, Number(pageSize) || 1);
  const pages = [];
  for (let i = 0; i < items.length; i += size) {
    pages.push(items.slice(i, i + size));
  }
  return pages.length ? pages : [[]];
}

/**
 * Resolve ordered list of workers to process, then yield pages.
 *
 * Sources (first match wins):
 *  1. Explicit single workerWid (CLI / env)
 *  2. workersFile
 *  3. workersReportBody (WIDs-only RaaS JSON/XML)
 *  4. preloaded workers array
 */
export async function* iterateWorkerPages({
  workerWid = null,
  workersFile = null,
  workersReportBody = null,
  workers = null,
  pageSize = 10,
  maxPages = null,
  maxEmployees = null,
  /** When true and metadata exists, skip workers with no allow-listed docs */
  onlyWithAllowedDocs = false,
  documentFilters = null,
}) {
  let list = [];

  if (workerWid) {
    list = [{ wid: String(workerWid).trim() }];
  } else if (workersFile) {
    list = await loadWorkersFile(workersFile);
  } else if (workersReportBody) {
    list = parseWorkersReport(workersReportBody);
  } else if (Array.isArray(workers) && workers.length) {
    list = workers.map(normalizeWorker);
  } else {
    throw new Error(
      'No workers to process. Provide --worker-wid, --workers-file, or the WIDs-only report URL.'
    );
  }

  // De-dupe by wid while preserving order
  const seen = new Set();
  list = list.filter((w) => {
    if (!w?.wid || seen.has(w.wid)) return false;
    seen.add(w.wid);
    return true;
  });

  const totalBeforeFilter = list.length;

  if (onlyWithAllowedDocs && documentFilters) {
    list = list.filter((w) => workerHasAllowedDocument(w, documentFilters));
  }

  if (maxEmployees != null && maxEmployees > 0) {
    list = list.slice(0, maxEmployees);
  }

  const pages = chunkPages(list, pageSize);
  const limit = maxPages != null ? Math.min(pages.length, maxPages) : pages.length;

  for (let pageIndex = 0; pageIndex < limit; pageIndex++) {
    yield {
      pageIndex: pageIndex + 1,
      totalPages: limit,
      totalWorkers: list.length,
      totalWorkersBeforeFilter: totalBeforeFilter,
      workers: pages[pageIndex],
    };
  }
}

export async function loadWorkersFile(filePath) {
  const raw = await fs.readFile(filePath, 'utf8');
  const trimmed = raw.trim();
  if (!trimmed) return [];

  if (trimmed.startsWith('[') || trimmed.startsWith('{')) {
    const parsed = JSON.parse(trimmed);
    const arr = Array.isArray(parsed) ? parsed : parsed.workers || parsed.Report_Entry || [];
    return arr.map(normalizeWorker).filter((w) => w.wid);
  }

  return trimmed
    .split(/[\r\n,]+/)
    .map((s) => s.trim())
    .filter(Boolean)
    .map((wid) => ({ wid }));
}

/**
 * Parse WIDs-only RaaS payload (JSON preferred).
 * Shape from API_Review_Document_-_Copy:
 *   { Report_Entry: [{ EmployeeID, Fullname, workdayID, Review_Documents_group: [...] }] }
 */
export function parseWorkersReport(body) {
  const trimmed = body.trim();
  if (!trimmed) return [];

  if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
    const json = JSON.parse(trimmed);
    const entries = Array.isArray(json)
      ? json
      : json.Report_Entry || json.report_entry || json.workers || [];
    return (Array.isArray(entries) ? entries : [entries]).map(normalizeWorker).filter((w) => w.wid);
  }

  const parser = new XMLParser({
    ignoreAttributes: false,
    attributeNamePrefix: '@_',
    removeNSPrefix: true,
    isArray: (name) => ['Report_Entry', 'Review_Documents_group'].includes(name),
  });
  const parsed = parser.parse(trimmed);
  const reportData = parsed?.Report_Data ?? parsed;
  const entries = reportData?.Report_Entry;
  const arr = Array.isArray(entries) ? entries : entries ? [entries] : [];
  return arr.map(normalizeWorker).filter((w) => w.wid);
}

function normalizeWorker(item) {
  if (item == null) return { wid: '' };
  if (typeof item === 'string') return { wid: item.trim() };

  const wid =
    item.wid ||
    item.WID ||
    item.workdayID ||
    item.WorkdayID ||
    item.Worker_WID ||
    item.workerWid ||
    item.id ||
    item.ID ||
    nestedId(item);

  const employeeId =
    item.employeeId ||
    item.EmployeeID ||
    item.Employee_ID ||
    item.employee_id ||
    undefined;

  const fullName = item.Fullname || item.fullName || item.full_name || undefined;

  const docGroups = asArray(item.Review_Documents_group || item.review_documents_group);
  const documents = docGroups.map((g) => ({
    docCategory: descriptorOrText(g.DocCategory ?? g.docCategory),
    documentDescriptor: descriptorOrText(g.Document ?? g.document),
  }));

  return {
    wid: wid ? String(wid).trim() : '',
    employeeId: employeeId != null ? String(employeeId).trim() : undefined,
    fullName: fullName != null ? String(fullName).trim() : undefined,
    documents,
  };
}

function workerHasAllowedDocument(worker, filters) {
  if (!worker.documents?.length) {
    // No metadata: keep the worker (will fetch detail report)
    return true;
  }
  return worker.documents.some((d) =>
    isAllowedDocument(d.docCategory, d.documentDescriptor, filters)
  );
}

function asArray(value) {
  if (value === undefined || value === null) return [];
  return Array.isArray(value) ? value : [value];
}

function descriptorOrText(node) {
  if (node === undefined || node === null) return '';
  if (typeof node === 'string' || typeof node === 'number') return String(node).trim();
  if (typeof node === 'object') {
    return (
      node['@_Descriptor'] ||
      node.Descriptor ||
      (node['#text'] != null ? String(node['#text']).trim() : '')
    );
  }
  return '';
}

function nestedId(item) {
  if (item.Worker?.id) return item.Worker.id;
  if (item.Worker?.WID) return item.Worker.WID;
  return '';
}
