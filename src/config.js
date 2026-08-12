import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const ROOT_DIR = path.resolve(__dirname, '..');

/** Local stand-in for FTP when --mock true; also used as local cache in live mode */
export const MOCK_FTP_DIR = path.join(ROOT_DIR, 'mock');

export const SAMPLE_RESPONSE_PATH = path.join(
  ROOT_DIR,
  'assets',
  'review-document-sample-response.xml'
);

export const CREDENTIALS_DIR = path.join(ROOT_DIR, 'assets', 'credentials');

/**
 * Allowed document filters for report-info (requirements.md lines 12–27 only).
 */
export const REPORT_INFO_DOCUMENT_FILTERS = [
  {
    category: 'Company Policy Related',
    documents: [
      'Hazardous Drug Handling Acknowledgement of Risk',
      'Consent For Electronic Notice',
      '6-Month Probationary Period Acknowlegement',
      '6-Month Probationary Period Acknowledgement',
      'Confidentiality Commitment',
      'Computer Security Agreement',
    ],
  },
  {
    category: 'Onboarding',
    documents: [
      'BH Stark Questionnaire',
      'BH Photographic & Video Consent & Release',
      'Policy Acknowlegement',
      'Policy Acknowledgement',
    ],
  },
];

/** @type {string|null} absolute path of loaded config file */
let activeConfigPath = null;
/** @type {object|null} */
let loadedFileConfig = null;

/**
 * Require a config path from CLI or WORKDAY_CONFIG.
 * @param {string|null|undefined} configPath
 * @returns {string}
 */
export function requireConfigPath(configPath) {
  const fromArg = configPath != null ? String(configPath).trim() : '';
  const fromEnv =
    process.env.WORKDAY_CONFIG != null
      ? String(process.env.WORKDAY_CONFIG).trim()
      : '';
  const value = fromArg || fromEnv;
  if (!value) {
    throw new Error(
      'Missing required configuration.\n' +
        '  Provide --config <path> or set WORKDAY_CONFIG.\n' +
        '  Example: --config assets/credentials/preview-configuration.json'
    );
  }
  return value;
}

/**
 * Resolve a config path (relative paths are from process.cwd(), then project root).
 * @param {string} configPath
 * @returns {string} absolute path
 */
export function resolveConfigPath(configPath) {
  const raw = requireConfigPath(configPath);
  if (path.isAbsolute(raw)) {
    return raw;
  }
  const fromCwd = path.resolve(process.cwd(), raw);
  if (fs.existsSync(fromCwd)) return fromCwd;
  const fromRoot = path.resolve(ROOT_DIR, raw);
  if (fs.existsSync(fromRoot)) return fromRoot;
  // Prefer cwd path in the error message even if missing
  return fromCwd;
}

/**
 * Load credentials/tenant/SFTP from a configuration JSON file.
 * Call once at process start from CLI `--config` (or WORKDAY_CONFIG).
 * Both are mandatory — there is no default path.
 *
 * @param {string|null|undefined} configPath
 * @returns {string} absolute path loaded
 */
export function setActiveConfig(configPath) {
  const resolved = resolveConfigPath(configPath);
  if (!fs.existsSync(resolved)) {
    throw new Error(
      `Config file not found: ${resolved}\n` +
        '  Provide a valid --config <path> or WORKDAY_CONFIG.\n' +
        '  Example: --config assets/credentials/preview-configuration.json'
    );
  }
  try {
    const raw = fs.readFileSync(resolved, 'utf8');
    const parsed = JSON.parse(raw);
    validateConfigFile(parsed, resolved);
    activeConfigPath = resolved;
    loadedFileConfig = parsed;
    return activeConfigPath;
  } catch (err) {
    if (
      err.message.startsWith('Missing required configuration') ||
      err.message.startsWith('Config file not found') ||
      err.message.startsWith('Invalid config')
    ) {
      throw err;
    }
    throw new Error(`Failed to load config ${resolved}: ${err.message}`);
  }
}

export function getActiveConfigPath() {
  if (!activeConfigPath) {
    throw new Error(
      'Configuration has not been loaded.\n' +
        '  Provide --config <path> or set WORKDAY_CONFIG before running.\n' +
        '  Example: --config assets/credentials/preview-configuration.json'
    );
  }
  return activeConfigPath;
}

/**
 * Raw JSON from the active configuration file.
 */
export function getEnvironmentFileConfig() {
  if (!loadedFileConfig) {
    getActiveConfigPath();
  }
  return loadedFileConfig;
}

function validateConfigFile(cfg, filePath) {
  if (!cfg || typeof cfg !== 'object') {
    throw new Error(`Invalid config (not an object): ${filePath}`);
  }
  for (const key of ['soapCredentials', 'basicCredentials', 'Tenant_domain', 'Tenant_server']) {
    if (cfg[key] == null || cfg[key] === '') {
      throw new Error(`Invalid config ${filePath}: missing "${key}"`);
    }
  }
  if (!cfg.soapCredentials?.User || !cfg.soapCredentials?.Password) {
    throw new Error(`Invalid config ${filePath}: soapCredentials.User/Password required`);
  }
  if (!cfg.basicCredentials?.User || !cfg.basicCredentials?.Password) {
    throw new Error(`Invalid config ${filePath}: basicCredentials.User/Password required`);
  }
}

function envOr(fileValue, envKey) {
  const fromEnv = process.env[envKey];
  if (fromEnv !== undefined && fromEnv !== null && String(fromEnv).trim() !== '') {
    return fromEnv;
  }
  return fileValue;
}

/**
 * Tenant host + name from the active configuration file.
 */
export function getTenantConfig() {
  const file = getEnvironmentFileConfig();
  return {
    configPath: getActiveConfigPath(),
    domain: envOr(file.Tenant_domain, 'WORKDAY_DOMAIN') || envOr(null, 'WORKDAY_BLOBITORY_HOST'),
    tenant: envOr(file.Tenant_server, 'WORKDAY_TENANT'),
  };
}

/**
 * RaaS customreport2 base:
 *   https://{domain}/ccx/service/customreport2/{tenant}/{basicUser}/{reportName}
 *
 * @param {string} reportName e.g. API_Education, CR_Export_Pay_Increase_-_Copy
 */
export function buildRaasUrl(reportName) {
  if (!reportName) throw new Error('reportName is required for buildRaasUrl');
  const file = getEnvironmentFileConfig();
  const { domain, tenant } = getTenantConfig();
  const user = envOr(file.basicCredentials.User, 'WORKDAY_USERNAME');
  const name = String(reportName).replace(/^\/+/, '');
  return `https://${domain}/ccx/service/customreport2/${tenant}/${user}/${name}`;
}

/**
 * Staffing SOAP endpoint:
 *   https://{domain}/ccx/service/{tenant}/Staffing/{version}
 */
export function buildStaffingUrl(version = 'v46.0') {
  const { domain, tenant } = getTenantConfig();
  return `https://${domain}/ccx/service/${tenant}/Staffing/${version}`;
}

/**
 * Recruiting SOAP endpoint:
 *   https://{domain}/ccx/service/{tenant}/Recruiting/{version}
 */
export function buildRecruitingUrl(version = 'v46.1') {
  const { domain, tenant } = getTenantConfig();
  return `https://${domain}/ccx/service/${tenant}/Recruiting/${version}`;
}

/**
 * Workday RaaS (Basic Auth) credentials + default review-document URLs.
 */
export function getWorkdayConfig() {
  const file = getEnvironmentFileConfig();
  const basic = file.basicCredentials;
  return {
    configPath: getActiveConfigPath(),
    username: envOr(basic.User, 'WORKDAY_USERNAME'),
    password: envOr(basic.Password, 'WORKDAY_PASSWORD'),
    reportUrl: envOr(null, 'WORKDAY_REPORT_URL') || buildRaasUrl('API_Review_Document'),
    workersReportUrl:
      envOr(null, 'WORKDAY_WORKERS_REPORT_URL') ||
      buildRaasUrl('API_Review_Document_-_Copy'),
    workerWid: process.env.WORKDAY_WORKER_WID || null,
    domain: getTenantConfig().domain,
    tenant: getTenantConfig().tenant,
  };
}

/**
 * SOAP / Blobitory credentials (username@tenant form).
 */
export function getBlobitoryConfig() {
  const file = getEnvironmentFileConfig();
  const soap = file.soapCredentials;
  const { domain, tenant } = getTenantConfig();
  return {
    configPath: getActiveConfigPath(),
    host:
      process.env.WORKDAY_BLOBITORY_HOST ||
      process.env.WORKDAY_DOMAIN ||
      domain,
    tenant,
    username:
      process.env.WORKDAY_BLOBITORY_USERNAME ||
      process.env.WORKDAY_STAFFING_USERNAME ||
      soap.User,
    password:
      process.env.WORKDAY_BLOBITORY_PASSWORD ||
      process.env.WORKDAY_STAFFING_PASSWORD ||
      process.env.WORKDAY_PASSWORD ||
      soap.Password,
  };
}

/**
 * Staffing SOAP credentials (same as soapCredentials / blobitory).
 */
export function getStaffingConfig() {
  const blob = getBlobitoryConfig();
  return {
    configPath: getActiveConfigPath(),
    username: process.env.WORKDAY_STAFFING_USERNAME || blob.username,
    password: process.env.WORKDAY_STAFFING_PASSWORD || blob.password,
    staffingUrl: process.env.WORKDAY_STAFFING_URL || buildStaffingUrl(),
  };
}

/**
 * Infor SFTP from sftpCredentials in the configuration file.
 */
export function getSftpConfig() {
  const file = getEnvironmentFileConfig();
  const sftp = file.sftpCredentials || {};
  return {
    configPath: getActiveConfigPath(),
    host: envOr(sftp.Host, 'SFTP_HOST') || 'sftp.inforcloudsuite.com',
    port: Number(envOr(sftp.Port, 'SFTP_PORT') || 22),
    username: envOr(sftp.User, 'SFTP_USERNAME'),
    password: envOr(sftp.Password, 'SFTP_PASSWORD'),
    remoteRoot: envOr(sftp.RemoteRoot, 'SFTP_REMOTE_ROOT') || '/ROI/Workday',
  };
}

/**
 * One-line summary for logs (no passwords).
 */
export function describeActiveConfig() {
  const configPath = getActiveConfigPath();
  const { domain, tenant } = getTenantConfig();
  const wd = getWorkdayConfig();
  const sftp = getSftpConfig();
  // Prefer path relative to project root when possible
  let displayPath = configPath;
  if (configPath.startsWith(ROOT_DIR)) {
    displayPath = path.relative(ROOT_DIR, configPath).split(path.sep).join('/');
  }
  return (
    `config=${displayPath} tenant=${tenant} domain=${domain} ` +
    `basicUser=${wd.username} sftp=${sftp.username}@${sftp.host}:${sftp.port}${sftp.remoteRoot}`
  );
}
