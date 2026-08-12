import fs from 'node:fs/promises';
import path from 'node:path';
import { ROOT_DIR } from '../config.js';

/**
 * Success + dead-letter process files for full-population runs.
 *
 * Layout (JSONL, one record per line):
 *   reports/process/{api}-success-ids.jsonl
 *   reports/process/{api}-dead-letter-ids.jsonl
 *
 * Rules:
 *   - Skip employees already in the success file for this API
 *   - On permanent failure (e.g. invalid Employee_ID), append dead-letter (no retry)
 *   - Success records are appended after a worker finishes successfully
 */

export const PROCESS_DIR = path.join(ROOT_DIR, 'reports', 'process');

/**
 * @param {string} api
 * @returns {{ successPath: string, deadLetterPath: string }}
 */
export function processFilePaths(api) {
  const safe = sanitizeApiName(api);
  return {
    successPath: path.join(PROCESS_DIR, `${safe}-success-ids.jsonl`),
    deadLetterPath: path.join(PROCESS_DIR, `${safe}-dead-letter-ids.jsonl`),
  };
}

/**
 * @param {string} api
 */
export function sanitizeApiName(api) {
  return String(api || 'unknown')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-');
}

/**
 * Load existing success and dead-letter IDs for an API.
 * @param {string} api
 * @returns {Promise<{ successIds: Set<string>, deadLetterIds: Set<string>, successPath: string, deadLetterPath: string }>}
 */
export async function loadProcessTracker(api) {
  const { successPath, deadLetterPath } = processFilePaths(api);
  await fs.mkdir(PROCESS_DIR, { recursive: true });
  const successIds = await readIdSet(successPath);
  const deadLetterIds = await readIdSet(deadLetterPath);
  return { successIds, deadLetterIds, successPath, deadLetterPath };
}

/**
 * @param {string} filePath
 * @returns {Promise<Set<string>>}
 */
export async function readIdSet(filePath) {
  const ids = new Set();
  let text = '';
  try {
    text = await fs.readFile(filePath, 'utf8');
  } catch (err) {
    if (err && err.code === 'ENOENT') return ids;
    throw err;
  }
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const row = JSON.parse(trimmed);
      const id = row.employeeId ?? row.employee_id ?? row.id;
      if (id != null && String(id).trim()) ids.add(String(id).trim());
    } catch {
      // ignore malformed lines
    }
  }
  return ids;
}

/**
 * Append a success record (and add to in-memory set).
 * @param {{ successPath: string, successIds: Set<string> }} tracker
 * @param {{ employeeId: string, api: string, files?: number, [k: string]: unknown }} record
 */
export async function recordSuccess(tracker, record) {
  const employeeId = String(record.employeeId).trim();
  if (!employeeId) return;
  tracker.successIds.add(employeeId);
  const row = {
    employeeId,
    api: record.api,
    at: record.at || new Date().toISOString(),
    files: record.files ?? 0,
  };
  await appendJsonl(tracker.successPath, row);
}

/**
 * Append a dead-letter record (permanent failure; no retry).
 * @param {{ deadLetterPath: string, deadLetterIds: Set<string> }} tracker
 * @param {{ employeeId: string, api: string, reason: string, [k: string]: unknown }} record
 */
export async function recordDeadLetter(tracker, record) {
  const employeeId = String(record.employeeId).trim();
  if (!employeeId) return;
  tracker.deadLetterIds.add(employeeId);
  const row = {
    employeeId,
    api: record.api,
    reason: record.reason || 'unknown',
    at: record.at || new Date().toISOString(),
  };
  await appendJsonl(tracker.deadLetterPath, row);
}

/**
 * Classify whether an error is a permanent invalid Employee_ID (dead-letter).
 * @param {string|Error} err
 * @returns {boolean}
 */
export function isInvalidEmployeeIdError(err) {
  const msg = typeof err === 'string' ? err : err?.message || String(err || '');
  return (
    /not a valid ID value for type\s*=\s*['"]?Employee_ID/i.test(msg) ||
    /Invalid ID value/i.test(msg) && /Employee_ID/i.test(msg)
  );
}

/**
 * Decide if an employee should be processed.
 * @param {{ successIds: Set<string>, deadLetterIds: Set<string> }} tracker
 * @param {string} employeeId
 * @param {{ skipDeadLetter?: boolean }} [options] skipDeadLetter default true
 * @returns {{ process: boolean, reason?: string }}
 */
export function shouldProcessEmployee(tracker, employeeId, options = {}) {
  const id = String(employeeId || '').trim();
  if (!id) return { process: false, reason: 'empty_employee_id' };
  if (tracker.successIds.has(id)) {
    return { process: false, reason: 'already_success' };
  }
  const skipDead = options.skipDeadLetter !== false;
  if (skipDead && tracker.deadLetterIds.has(id)) {
    return { process: false, reason: 'dead_letter' };
  }
  return { process: true };
}

/**
 * @param {string} filePath
 * @param {object} row
 */
export async function appendJsonl(filePath, row) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const line = JSON.stringify(row) + '\n';
  await fs.appendFile(filePath, line, 'utf8');
}
