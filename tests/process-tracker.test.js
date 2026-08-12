import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {
  sanitizeApiName,
  shouldProcessEmployee,
  isInvalidEmployeeIdError,
  appendJsonl,
  readIdSet,
  processFilePaths,
} from '../src/lib/process-tracker.js';

describe('process-tracker', () => {
  it('sanitizeApiName normalizes names', () => {
    assert.equal(sanitizeApiName('Personal'), 'personal');
    assert.equal(sanitizeApiName('benefit-event'), 'benefit-event');
  });

  it('shouldProcessEmployee skips success and dead-letter', () => {
    const tracker = {
      successIds: new Set(['100']),
      deadLetterIds: new Set(['200']),
    };
    assert.equal(shouldProcessEmployee(tracker, '100').process, false);
    assert.equal(shouldProcessEmployee(tracker, '100').reason, 'already_success');
    assert.equal(shouldProcessEmployee(tracker, '200').process, false);
    assert.equal(shouldProcessEmployee(tracker, '200').reason, 'dead_letter');
    assert.equal(shouldProcessEmployee(tracker, '300').process, true);
  });

  it('isInvalidEmployeeIdError detects Staffing validation faults', () => {
    assert.equal(
      isInvalidEmployeeIdError(
        "Validation error occurred. Invalid ID value.  '32967' is not a valid ID value for type = 'Employee_ID'"
      ),
      true
    );
    assert.equal(isInvalidEmployeeIdError('timeout of 30000ms exceeded'), false);
    assert.equal(
      isInvalidEmployeeIdError(new Error("Invalid ID value for type = 'Employee_ID'")),
      true
    );
  });

  it('appendJsonl and readIdSet round-trip', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'wd-tracker-'));
    const file = path.join(dir, 'test-success.jsonl');
    await appendJsonl(file, { employeeId: '111', api: 'personal', files: 2 });
    await appendJsonl(file, { employeeId: '222', api: 'personal', files: 0 });
    const ids = await readIdSet(file);
    assert.ok(ids.has('111'));
    assert.ok(ids.has('222'));
    assert.equal(ids.size, 2);
    await fs.rm(dir, { recursive: true, force: true });
  });

  it('processFilePaths uses reports/process layout', () => {
    const p = processFilePaths('personal');
    assert.match(p.successPath.replace(/\\/g, '/'), /reports\/process\/personal-success-ids\.jsonl$/);
    assert.match(
      p.deadLetterPath.replace(/\\/g, '/'),
      /reports\/process\/personal-dead-letter-ids\.jsonl$/
    );
  });
});
