/**
 * Low-level Workday HTTP helpers (RaaS customreport2).
 *
 * All-employee flow:
 *  1) WIDs-only report (API_Review_Document_-_Copy) → all EmployeeID + workdayID
 *  2) For each workdayID → detail report (API_Review_Document?Worker!WID=...)
 */

function basicAuthHeader(username, password) {
  return `Basic ${Buffer.from(`${username}:${password}`, 'utf8').toString('base64')}`;
}

async function fetchText(url, { username, password, accept, timeoutMs }) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(url, {
      method: 'GET',
      headers: {
        Authorization: basicAuthHeader(username, password),
        Accept: accept,
        'Content-Type': 'application/soap+xml',
      },
      signal: controller.signal,
    });

    const body = await response.text();
    if (!response.ok) {
      throw new Error(
        `Workday request failed (${response.status} ${response.statusText}): ${body.slice(0, 500)}`
      );
    }
    return body;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Fetch Review Document RaaS as XML for one worker (attachments + base64).
 */
export async function fetchWorkdayReport({
  reportUrl,
  username,
  password,
  workerWid,
  timeoutMs = 5 * 60 * 1000,
}) {
  if (!reportUrl) throw new Error('WORKDAY_REPORT_URL is required for live mode');
  if (!username || !password) {
    throw new Error('WORKDAY_USERNAME and WORKDAY_PASSWORD are required for live mode');
  }
  if (!workerWid) {
    throw new Error('workerWid is required for the detail report (Worker!WID)');
  }

  const url = new URL(reportUrl);
  url.searchParams.set('format', 'xml');
  url.searchParams.set('Worker!WID', workerWid);

  return fetchText(url.toString(), {
    username,
    password,
    accept: 'application/xml, application/soap+xml, text/xml, */*',
    timeoutMs,
  });
}

/**
 * Fetch WIDs-only RaaS (all employees: EmployeeID + workdayID + doc metadata, no base64).
 */
export async function fetchWorkersReport({
  workersReportUrl,
  username,
  password,
  timeoutMs = 10 * 60 * 1000,
}) {
  if (!workersReportUrl) {
    throw new Error('WORKDAY_WORKERS_REPORT_URL is required to list all employees');
  }
  if (!username || !password) {
    throw new Error('WORKDAY_USERNAME and WORKDAY_PASSWORD are required for live mode');
  }

  const url = new URL(workersReportUrl);
  if (!url.searchParams.has('format')) {
    url.searchParams.set('format', 'json');
  }

  return fetchText(url.toString(), {
    username,
    password,
    accept: 'application/json, application/xml, text/*',
    timeoutMs,
  });
}
