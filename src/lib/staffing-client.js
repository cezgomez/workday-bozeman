/**
 * Workday Staffing SOAP client (Get_Workers with worker documents).
 *
 * Used by education API: list employees from RaaS, then pull File base64
 * from Staffing Get_Workers (Include_Worker_Documents=true).
 */

function buildGetWorkersEnvelope({ employeeId, username, password }) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/"
                  xmlns:wd="urn:com.workday/bsvc"
                  xmlns:wsse="http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-wssecurity-secext-1.0.xsd"
                  xmlns:wsu="http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-wssecurity-utility-1.0.xsd">
    <soapenv:Header>
        <wsse:Security soapenv:mustUnderstand="1">
            <wsse:UsernameToken wsu:Id="UsernameToken-1">
                <wsse:Username>${escapeXml(username)}</wsse:Username>
                <wsse:Password Type="http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-username-token-profile-1.0#PasswordText">${escapeXml(password)}</wsse:Password>
                <wsu:Created>2020-04-27T10:16:10.235Z</wsu:Created>
            </wsse:UsernameToken>
        </wsse:Security>
    </soapenv:Header>
    <soapenv:Body>
        <wd:Get_Workers_Request version="v46.0">
            <wd:Request_References>
                <wd:Worker_Reference>
                    <wd:ID wd:type="Employee_ID">${escapeXml(employeeId)}</wd:ID>
                </wd:Worker_Reference>
            </wd:Request_References>
            <wd:Response_Group>
                <wd:Include_Worker_Documents>true</wd:Include_Worker_Documents>
            </wd:Response_Group>
            <wd:Response_Filter>
                <wd:Page>1</wd:Page>
                <wd:Count>100</wd:Count>
            </wd:Response_Filter>
        </wd:Get_Workers_Request>
    </soapenv:Body>
</soapenv:Envelope>`;
}

/**
 * POST Get_Workers for one Employee_ID; returns raw SOAP XML.
 */
export async function fetchWorkerDocumentsSoap({
  employeeId,
  username,
  password,
  staffingUrl,
  timeoutMs = 5 * 60 * 1000,
}) {
  if (!employeeId) throw new Error('employeeId is required for Staffing Get_Workers');
  if (!username || !password) {
    throw new Error('Staffing username/password are required');
  }
  if (!staffingUrl) throw new Error('Staffing URL is required');

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(staffingUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/soap+xml',
        Accept: 'application/soap+xml, text/xml, */*',
      },
      body: buildGetWorkersEnvelope({ employeeId, username, password }),
      signal: controller.signal,
    });

    const body = await response.text();
    if (!response.ok) {
      throw new Error(
        `Staffing Get_Workers failed (${response.status} ${response.statusText}): ${body.slice(0, 500)}`
      );
    }
    if (/SOAP-ENV:Fault|soapenv:Fault|faultstring/i.test(body)) {
      const fault = body.match(/<faultstring>([^<]+)/i)?.[1] || body.slice(0, 400);
      throw new Error(`Staffing Get_Workers SOAP fault: ${fault}`);
    }
    return body;
  } finally {
    clearTimeout(timer);
  }
}

function escapeXml(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}
