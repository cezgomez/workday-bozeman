import path from 'node:path';
import SftpClient from 'ssh2-sftp-client';
import { getSftpConfig } from '../config.js';

/**
 * Thin wrapper around ssh2-sftp-client for uploading report files under remoteRoot.
 * Uploads are serialized (mutex) so parallel worker fetches can share one connection safely.
 */
export class FtpUploader {
  constructor(config = getSftpConfig()) {
    this.config = config;
    this.client = new SftpClient();
    this.connected = false;
    this.uploaded = 0;
    this.errors = [];
    /** @type {Promise<void>} */
    this._queue = Promise.resolve();
  }

  async connect() {
    if (this.connected) return;
    const { host, port, username, password } = this.config;
    console.log(`[sftp] connecting ${username}@${host}:${port} ...`);
    await this.client.connect({
      host,
      port,
      username,
      password,
      readyTimeout: 60_000,
    });
    this.connected = true;
    console.log(`[sftp] connected; remote root: ${this.config.remoteRoot}`);
  }

  /**
   * Upload a local file (or Buffer) to remoteRoot/relativePath, creating dirs as needed.
   * Concurrent callers are queued so only one SFTP op runs at a time.
   */
  async upload({ relativePath, localPath, buffer }) {
    const run = async () => {
      await this.connect();
      const remotePath = toPosix(path.posix.join(this.config.remoteRoot, toPosix(relativePath)));
      const remoteDir = path.posix.dirname(remotePath);

      try {
        await this.client.mkdir(remoteDir, true);
        if (buffer) {
          await this.client.put(buffer, remotePath);
        } else if (localPath) {
          await this.client.put(localPath, remotePath);
        } else {
          throw new Error('upload requires localPath or buffer');
        }
        this.uploaded += 1;
        return { ok: true, remotePath };
      } catch (err) {
        this.errors.push({ relativePath, error: err.message });
        throw err;
      }
    };

    // Chain onto queue; rethrow errors to caller without breaking the queue
    const result = this._queue.then(run, run);
    this._queue = result.then(
      () => undefined,
      () => undefined
    );
    return result;
  }

  async end() {
    // Wait for in-flight uploads
    await this._queue;
    if (!this.connected) return;
    try {
      await this.client.end();
    } catch {
      // ignore close errors
    }
    this.connected = false;
    console.log(`[sftp] closed (uploaded=${this.uploaded} errors=${this.errors.length})`);
  }
}

function toPosix(p) {
  return String(p).replace(/\\/g, '/');
}
