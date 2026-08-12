import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  toDirectoryName,
  sanitizeFileNamePart,
  buildGeneratedDocumentPath,
  buildOutputPath,
} from '../src/lib/naming.js';

describe('naming', () => {
  it('toDirectoryName replaces spaces with underscores', () => {
    assert.equal(
      toDirectoryName('Company Policy Related'),
      'Company_Policy_Related'
    );
  });

  it('sanitizeFileNamePart removes spaces and underscores', () => {
    assert.equal(
      sanitizeFileNamePart('Alex EMT Certificate.pdf'.replace(/\.pdf$/, '')),
      'AlexEMTCertificate'
    );
    assert.equal(sanitizeFileNamePart('BACKGROUND CHECK'), 'BACKGROUNDCHECK');
    assert.equal(
      sanitizeFileNamePart('CANDIDATE_RESUME_AND_COVER_LETTER'),
      'CANDIDATERESUMEANDCOVERLETTER'
    );
  });

  it('buildGeneratedDocumentPath follows 100_emp_prefix_file pattern', () => {
    const p = buildGeneratedDocumentPath({
      directoryName: 'Personal',
      filePrefix: 'BENEFITS',
      employeeId: '49494',
      attachmentDescriptor: 'Divorce.pdf',
    });
    assert.match(p.replace(/\\/g, '/'), /Personal\/100_49494_BENEFITS_Divorce\.pdf$/);
  });

  it('buildOutputPath uses descriptor for dir and file', () => {
    const p = buildOutputPath({
      documentDescriptor: 'Hazardous Drug Handling',
      employeeId: '100',
      attachmentDescriptor: 'form.pdf',
    });
    assert.match(p.replace(/\\/g, '/'), /Hazardous_Drug_Handling\/100_100_/);
  });
});
