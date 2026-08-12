/**
 * CLI:
 *   node src/index.js --api report-info --mock true
 *   node src/index.js --api report-info --mock false
 *   node src/index.js --api report-info --mock false --page-size 20 --max-pages 1
 */
export function parseArgs(argv = process.argv.slice(2)) {
  const args = {
    api: null,
    mock: false,
    config: null,
    workerWid: null,
    workersFile: null,
    pageSize: 5,
    maxPages: null,
    maxEmployees: null,
    concurrency: 5,
    help: false,
    listApis: false,
  };

  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];
    const next = argv[i + 1];

    if (token === '--help' || token === '-h') {
      args.help = true;
      continue;
    }

    if (token === '--list-apis') {
      args.listApis = true;
      continue;
    }

    if (token === '--api') {
      args.api = next ?? null;
      i++;
      continue;
    }
    if (token.startsWith('--api=')) {
      args.api = token.slice('--api='.length);
      continue;
    }

    if (token === '--config') {
      args.config = next ?? null;
      i++;
      continue;
    }
    if (token.startsWith('--config=')) {
      args.config = token.slice('--config='.length);
      continue;
    }

    if (token === '--mock') {
      args.mock = parseBoolean(next);
      i++;
      continue;
    }
    if (token.startsWith('--mock=')) {
      args.mock = parseBoolean(token.slice('--mock='.length));
      continue;
    }

    if (token === '--worker-wid') {
      args.workerWid = next ?? null;
      i++;
      continue;
    }
    if (token.startsWith('--worker-wid=')) {
      args.workerWid = token.slice('--worker-wid='.length);
      continue;
    }

    if (token === '--workers-file') {
      args.workersFile = next ?? null;
      i++;
      continue;
    }
    if (token.startsWith('--workers-file=')) {
      args.workersFile = token.slice('--workers-file='.length);
      continue;
    }

    if (token === '--page-size') {
      args.pageSize = parsePositiveInt(next, '--page-size');
      i++;
      continue;
    }
    if (token.startsWith('--page-size=')) {
      args.pageSize = parsePositiveInt(token.slice('--page-size='.length), '--page-size');
      continue;
    }

    if (token === '--max-pages') {
      args.maxPages = parsePositiveInt(next, '--max-pages');
      i++;
      continue;
    }
    if (token.startsWith('--max-pages=')) {
      args.maxPages = parsePositiveInt(token.slice('--max-pages='.length), '--max-pages');
      continue;
    }

    if (token === '--concurrency') {
      args.concurrency = parsePositiveInt(next, '--concurrency');
      i++;
      continue;
    }
    if (token.startsWith('--concurrency=')) {
      args.concurrency = parsePositiveInt(token.slice('--concurrency='.length), '--concurrency');
      continue;
    }

    if (token === '--max-employees') {
      args.maxEmployees = parsePositiveInt(next, '--max-employees');
      i++;
      continue;
    }
    if (token.startsWith('--max-employees=')) {
      args.maxEmployees = parsePositiveInt(
        token.slice('--max-employees='.length),
        '--max-employees'
      );
      continue;
    }
  }

  return args;
}

function parseBoolean(value) {
  if (value === undefined || value === null) return true;
  const v = String(value).trim().toLowerCase();
  if (['1', 'true', 'yes', 'y', 'on'].includes(v)) return true;
  if (['0', 'false', 'no', 'n', 'off'].includes(v)) return false;
  throw new Error(`Invalid boolean value for --mock: ${value}`);
}

function parsePositiveInt(value, flag) {
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1) {
    throw new Error(`${flag} must be a positive integer (got: ${value})`);
  }
  return n;
}

export function printHelp() {
  console.log(`
Workday API Client

Usage:
  node src/index.js --api <api-name> --config <path> --mock <true|false> [options]

Required:
  --api <name>              API name (see registry)
  --config <path>           Path to configuration JSON (or set WORKDAY_CONFIG)
                            No default — must be provided every run.

Credentials file examples:
  assets/credentials/preview-configuration.json
  assets/credentials/production-configuration.json
  assets/credentials/sandbox-configuration.json

  Schema:
    soapCredentials   → Staffing / Blobitory (User@tenant)
    basicCredentials  → RaaS Basic Auth
    sftpCredentials   → Infor SFTP
    Tenant_domain / Tenant_server → host + tenant for all Workday URLs

  WORKDAY_* / SFTP_* env vars still override individual file fields when set.

Options:
  --list-apis               List registered --api names and exit
  --mock <true|false>       true  = sample data path; false = live + SFTP
  --page-size <n>           Employees per batch (default: 5)
  --concurrency <n>         Parallel downloads within a batch (default: 5)
  --max-pages <n>           Stop after N batches
  --max-employees <n>       First N employees (or per-category for personal)
  --worker-wid <wid>        report-info: single worker only
  --workers-file <path>     report-info: local WID list
  -h, --help

Examples:
  node src/index.js --list-apis
  node src/index.js --api education --config assets/credentials/preview-configuration.json --mock false --max-employees 20
  node src/index.js --api personal --config assets/credentials/production-configuration.json --mock false --max-employees 10
`);
}
