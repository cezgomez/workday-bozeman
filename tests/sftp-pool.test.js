import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  normalizeSftpPoolSize,
  DEFAULT_SFTP_POOL_SIZE,
  MAX_SFTP_POOL_SIZE,
} from '../src/lib/sftp-client.js';

describe('sftp pool size', () => {
  it('defaults to 3', () => {
    assert.equal(DEFAULT_SFTP_POOL_SIZE, 3);
    assert.equal(MAX_SFTP_POOL_SIZE, 3);
  });

  it('clamps to 1–3', () => {
    assert.equal(normalizeSftpPoolSize(2), 2);
    assert.equal(normalizeSftpPoolSize(3), 3);
    assert.equal(normalizeSftpPoolSize(10), 3);
    assert.equal(normalizeSftpPoolSize(0), 3);
    assert.equal(normalizeSftpPoolSize(-1), 3);
    assert.equal(normalizeSftpPoolSize('2'), 2);
    assert.equal(normalizeSftpPoolSize(undefined), 3);
  });
});
