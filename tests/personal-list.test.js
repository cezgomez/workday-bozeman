import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  parsePersonalWorkerDocumentsSoap,
  sanitizePersonalCategoryPart,
  extractEmployeeIdsFromReportXml,
  PERSONAL_EXCLUDED_CATEGORIES,
} from '../src/lib/personal-list.js';

const sampleSoap = `<?xml version="1.0" encoding="utf-8"?>
<soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/" xmlns:wd="urn:com.workday/bsvc">
  <soapenv:Body>
    <wd:Get_Workers_Response>
      <wd:Response_Data>
        <wd:Worker>
          <wd:Worker_Data>
            <wd:Worker_ID>44567</wd:Worker_ID>
            <wd:Worker_Document_Data>
              <wd:Worker_Document>
                <wd:Worker_Document_Reference>
                  <wd:ID wd:type="WID">doc-cert-1</wd:ID>
                  <wd:ID wd:type="File_ID">FILE-1</wd:ID>
                </wd:Worker_Document_Reference>
                <wd:Worker_Document_Detail_Data>
                  <wd:Document_Category_Reference>
                    <wd:ID wd:type="Document_Category__Workday_Owned__ID">CERT</wd:ID>
                  </wd:Document_Category_Reference>
                  <wd:Filename>cert.pdf</wd:Filename>
                  <wd:File>QUJD</wd:File>
                </wd:Worker_Document_Detail_Data>
              </wd:Worker_Document>
              <wd:Worker_Document>
                <wd:Worker_Document_Reference>
                  <wd:ID wd:type="WID">doc-ben-1</wd:ID>
                  <wd:ID wd:type="File_ID">FILE-2</wd:ID>
                </wd:Worker_Document_Reference>
                <wd:Worker_Document_Detail_Data>
                  <wd:Document_Category_Reference>
                    <wd:ID wd:type="Document_Category__Workday_Owned__ID">BENEFITS</wd:ID>
                  </wd:Document_Category_Reference>
                  <wd:Filename>benefits.pdf</wd:Filename>
                  <wd:File>QUJD</wd:File>
                </wd:Worker_Document_Detail_Data>
              </wd:Worker_Document>
              <wd:Worker_Document>
                <wd:Worker_Document_Reference>
                  <wd:ID wd:type="WID">doc-none-1</wd:ID>
                </wd:Worker_Document_Reference>
                <wd:Worker_Document_Detail_Data>
                  <wd:Document_Category_Reference>
                    <wd:ID wd:type="Document_Category_ID">Onboarding</wd:ID>
                  </wd:Document_Category_Reference>
                  <wd:Filename>onboard.pdf</wd:Filename>
                  <wd:File>QUJD</wd:File>
                </wd:Worker_Document_Detail_Data>
              </wd:Worker_Document>
            </wd:Worker_Document_Data>
          </wd:Worker_Data>
        </wd:Worker>
      </wd:Response_Data>
    </wd:Get_Workers_Response>
  </soapenv:Body>
</soapenv:Envelope>`;

describe('personal-list', () => {
  it('excludes CERT LICENSES EDUCATION', () => {
    assert.ok(PERSONAL_EXCLUDED_CATEGORIES.has('CERT'));
    assert.ok(PERSONAL_EXCLUDED_CATEGORIES.has('EDUCATION'));
  });

  it('sanitizePersonalCategoryPart removes spaces only', () => {
    assert.equal(sanitizePersonalCategoryPart('BACKGROUND CHECK'), 'BACKGROUNDCHECK');
    assert.equal(
      sanitizePersonalCategoryPart('CANDIDATE_RESUME_AND_COVER_LETTER'),
      'CANDIDATE_RESUME_AND_COVER_LETTER'
    );
  });

  it('parsePersonalWorkerDocumentsSoap filters categories', () => {
    const { workerId, documents, skippedExcluded, skippedNoCategory } =
      parsePersonalWorkerDocumentsSoap(sampleSoap);
    assert.equal(workerId, '44567');
    assert.equal(documents.length, 1);
    assert.equal(documents[0].categoryOwnedId, 'BENEFITS');
    assert.equal(documents[0].filename, 'benefits.pdf');
    assert.ok(skippedExcluded >= 1);
    assert.ok(skippedNoCategory >= 1);
  });

  it('extractEmployeeIdsFromReportXml finds EmployeeID nodes', () => {
    const xml = `
      <Report_Data>
        <Report_Entry><EmployeeID>111</EmployeeID></Report_Entry>
        <Report_Entry><wd:EmployeeID xmlns:wd="urn:com.workday/bsvc">222</wd:EmployeeID></Report_Entry>
      </Report_Data>`;
    const ids = extractEmployeeIdsFromReportXml(xml);
    assert.ok(ids.includes('111'));
    assert.ok(ids.includes('222'));
  });
});
