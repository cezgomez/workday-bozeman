import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { parseArgs } from '../src/lib/cli.js';

describe('parseArgs', () => {
  it('defaults concurrency to 6 (5–8 band)', () => {
    const args = parseArgs([]);
    assert.equal(args.concurrency, 6);
    assert.equal(args.pageSize, 5);
    assert.equal(args.mock, false);
  });

  it('parses --api --config --concurrency --list-apis', () => {
    const args = parseArgs([
      '--api',
      'personal',
      '--config',
      'path/to/config.json',
      '--concurrency',
      '8',
      '--max-employees',
      '10',
      '--mock',
      'false',
    ]);
    assert.equal(args.api, 'personal');
    assert.equal(args.config, 'path/to/config.json');
    assert.equal(args.concurrency, 8);
    assert.equal(args.maxEmployees, 10);
    assert.equal(args.mock, false);
  });

  it('parses --list-apis', () => {
    const args = parseArgs(['--list-apis']);
    assert.equal(args.listApis, true);
  });

  it('parses --config= form', () => {
    const args = parseArgs(['--config=./cfg.json', '--api=education']);
    assert.equal(args.config, './cfg.json');
    assert.equal(args.api, 'education');
  });
});
