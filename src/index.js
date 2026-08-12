#!/usr/bin/env node
import 'dotenv/config';
import { apiRegistry, listApis } from './apis/index.js';
import { parseArgs, printHelp } from './lib/cli.js';
import {
  setActiveConfig,
  describeActiveConfig,
} from './config.js';

async function main() {
  const args = parseArgs();

  if (args.help) {
    printHelp();
    return;
  }

  if (args.listApis) {
    const apis = listApis();
    console.log('Available APIs:\n');
    for (const name of apis) {
      console.log(`  ${name}`);
    }
    console.log(`\nTotal: ${apis.length}`);
    return;
  }

  if (!args.api) {
    printHelp();
    console.error('Error: --api is required.\n');
    process.exitCode = 1;
    return;
  }

  if (!args.config && !(process.env.WORKDAY_CONFIG || '').trim()) {
    printHelp();
    console.error(
      'Error: --config is required (or set WORKDAY_CONFIG).\n' +
        '  Example: --config assets/credentials/preview-configuration.json\n'
    );
    process.exitCode = 1;
    return;
  }

  const handler = apiRegistry[args.api];
  if (!handler) {
    console.error(`Unknown --api "${args.api}". Available: ${listApis().join(', ')}`);
    process.exitCode = 1;
    return;
  }

  try {
    setActiveConfig(args.config || process.env.WORKDAY_CONFIG);
    console.log(`[config] ${describeActiveConfig()}`);

    await handler({
      mock: args.mock,
      workerWid: args.workerWid,
      workersFile: args.workersFile,
      pageSize: args.pageSize,
      maxPages: args.maxPages,
      maxEmployees: args.maxEmployees,
      concurrency: args.concurrency,
    });
  } catch (err) {
    console.error(`\nFailed: ${err.message}`);
    if (process.env.DEBUG) {
      console.error(err.stack);
    }
    process.exitCode = 1;
  }
}

main();
