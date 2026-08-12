import { isAllowedDocument } from './document-filter.js';
import { saveAttachment } from './file-saver.js';

/**
 * Filter allow-listed documents, save under local destination, optionally upload via SFTP.
 *
 * @param {object} options
 * @param {import('./sftp-client.js').FtpUploader|null} [options.uploader]
 */
export async function processAndSaveRecords(
  records,
  { filters, destination, logPrefix = '', uploader = null }
) {
  const matched = records.filter((r) =>
    isAllowedDocument(r.docCategory, r.documentDescriptor, filters)
  );
  const skippedFilter = records.length - matched.length;

  const results = {
    parsed: records.length,
    matched: matched.length,
    skippedFilter,
    saved: [],
    skipped: [],
    errors: [],
    uploaded: [],
  };

  for (const record of matched) {
    try {
      const outcome = await saveAttachment(destination, record);
      if (outcome.skipped) {
        results.skipped.push({
          employeeId: record.employeeId,
          document: record.documentDescriptor,
          docCategory: record.docCategory,
          reason: outcome.reason,
        });
        console.log(
          `${logPrefix}skip  emp=${record.employeeId} doc="${record.documentDescriptor}" (${outcome.reason})`
        );
        continue;
      }

      const savedItem = {
        employeeId: record.employeeId,
        document: record.documentDescriptor,
        docCategory: record.docCategory || 'Unknown',
        path: outcome.relativePath,
        bytes: outcome.bytes,
      };
      results.saved.push(savedItem);
      console.log(
        `${logPrefix}save  emp=${record.employeeId} -> ${outcome.relativePath} (${outcome.bytes} bytes)`
      );

      if (uploader) {
        try {
          const remote = await uploader.upload({
            relativePath: outcome.relativePath,
            localPath: outcome.absolutePath,
          });
          results.uploaded.push({
            employeeId: record.employeeId,
            document: record.documentDescriptor,
            docCategory: record.docCategory || 'Unknown',
            path: outcome.relativePath,
            remotePath: remote.remotePath,
          });
          console.log(`${logPrefix}sftp  ${remote.remotePath}`);
        } catch (sftpErr) {
          results.errors.push({
            employeeId: record.employeeId,
            document: record.documentDescriptor,
            error: `SFTP: ${sftpErr.message}`,
          });
          console.error(
            `${logPrefix}sftp error emp=${record.employeeId}: ${sftpErr.message}`
          );
        }
      }
    } catch (err) {
      results.errors.push({
        employeeId: record.employeeId,
        document: record.documentDescriptor,
        error: err.message,
      });
      console.error(
        `${logPrefix}error emp=${record.employeeId} doc="${record.documentDescriptor}": ${err.message}`
      );
    }
  }

  return results;
}

export function mergeResults(target, part) {
  target.parsed += part.parsed;
  target.matched += part.matched;
  target.skippedFilter += part.skippedFilter;
  target.saved.push(...part.saved);
  target.skipped.push(...part.skipped);
  target.errors.push(...part.errors);
  if (part.uploaded) {
    target.uploaded = target.uploaded || [];
    target.uploaded.push(...part.uploaded);
  }
  return target;
}
