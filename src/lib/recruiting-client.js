/**
 * Workday Recruiting SOAP client — Get_Candidate_Attachments.
 *
 * Used by other-document API: list Employee + Candidate_ID from RaaS,
 * then pull File_Content base64 via Recruiting.
 */

function buildGetCandidateAttachmentsEnvelope({ candidateId, username, password }) {
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
        <wd:Get_Candidate_Attachments_Request version="v46.1">
            <wd:Request_Criteria>
                <wd:Candidate_Reference>
                    <wd:ID wd:type="Candidate_ID">${escapeXml(candidateId)}</wd:ID>
                </wd:Candidate_Reference>
            </wd:Request_Criteria>
        </wd:Get_Candidate_Attachments_Request>
    </soapenv:Body>
</soapenv:Envelope>`;
}

/**
 * POST Get_Candidate_Attachments for one Candidate_ID; returns raw SOAP XML.
 */
export async function fetchCandidateAttachmentsSoap({
  candidateId,
  username,
  password,
  recruitingUrl,
  timeoutMs = 5 * 60 * 1000,
}) {
  if (!candidateId) throw new Error('candidateId is required for Get_Candidate_Attachments');
  if (!username || !password) {
    throw new Error('Recruiting username/password are required');
  }
  if (!recruitingUrl) throw new Error('Recruiting URL is required');

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(recruitingUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/soap+xml',
        Accept: 'application/soap+xml, text/xml, */*',
      },
      body: buildGetCandidateAttachmentsEnvelope({ candidateId, username, password }),
      signal: controller.signal,
    });

    const body = await response.text();
    if (!response.ok) {
      throw new Error(
        `Recruiting Get_Candidate_Attachments failed (${response.status} ${response.statusText}): ${body.slice(0, 500)}`
      );
    }
    if (/SOAP-ENV:Fault|soapenv:Fault|faultstring/i.test(body)) {
      const fault = body.match(/<faultstring>([^<]+)/i)?.[1] || body.slice(0, 400);
      throw new Error(`Recruiting SOAP fault: ${fault}`);
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
