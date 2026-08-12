/**
 * Workday cc-blobitory document download.
 *
 * URL pattern (from apis/job-description.sh):
 *   https://{host}/ccx/cc-blobitory/{tenant}/{Document_ID}
 *
 * Document_ID looks like: 9569ee135eb41000ceb4ddbbfdbd0000/bc7dd921-31bc-424e-bcf4-3703b466beb5
 *
 * Auth must be {username}@{tenant} (plain username returns 401).
 */

export async function fetchBlobitoryDocument({
  documentId,
  tenant = 'bozemanhealth_preview',
  host = 'wd2-impl-services1.workday.com',
  username,
  password,
  timeoutMs = 2 * 60 * 1000,
}) {
  if (!documentId) throw new Error('documentId is required for blobitory download');
  if (!username || !password) {
    throw new Error('Blobitory credentials are required (username@tenant + password)');
  }

  // Ensure user is in form user@tenant
  const authUser = username.includes('@') ? username : `${username}@${tenant}`;
  const auth = Buffer.from(`${authUser}:${password}`, 'utf8').toString('base64');

  // Document_ID may contain a slash — keep it as path segments
  const idPath = String(documentId)
    .split('/')
    .map((p) => encodeURIComponent(p))
    .join('/');
  const url = `https://${host}/ccx/cc-blobitory/${encodeURIComponent(tenant)}/${idPath}`;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(url, {
      method: 'GET',
      headers: {
        Authorization: `Basic ${auth}`,
        'X-Tenant': tenant,
        Accept: '*/*',
      },
      signal: controller.signal,
    });

    const buf = Buffer.from(await response.arrayBuffer());
    if (!response.ok) {
      throw new Error(
        `Blobitory failed (${response.status} ${response.statusText}): ${buf.toString('utf8').slice(0, 300)}`
      );
    }

    return {
      buffer: buf,
      contentType: response.headers.get('content-type') || 'application/octet-stream',
      url,
    };
  } finally {
    clearTimeout(timer);
  }
}
