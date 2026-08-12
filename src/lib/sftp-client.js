import path from 'node:path';
import SftpClient from 'ssh2-sftp-client';
import { getSftpConfig } from '../config.js';

/** Default concurrent SFTP connections (agreed range: 2–3). */
export const DEFAULT_SFTP_POOL_SIZE = 3;
export const MIN_SFTP_POOL_SIZE = 1;
export const MAX_SFTP_POOL_SIZE = 3;

/**
 * Clamp pool size to 1–3 (recommended 2–3 for full population runs).
 * @param {unknown} value
 * @param {number} [fallback]
 */
export function normalizeSftpPoolSize(value, fallback = DEFAULT_SFTP_POOL_SIZE) {
  const n = Number(value);
  if (!Number.isFinite(n) || n < 1) return fallback;
  return Math.min(MAX_SFTP_POOL_SIZE, Math.max(MIN_SFTP_POOL_SIZE, Math.floor(n)));
}

/**
 * SFTP uploader with a small connection pool (2–3 concurrent uploads).
 * Each connection handles one upload at a time; free connections are reused.
 */
export class FtpUploader {
  /**
   * @param {ReturnType<typeof getSftpConfig> & { poolSize?: number }} [config]
   */
  constructor(config = getSftpConfig()) {
    this.config = config;
    this.poolSize = normalizeSftpPoolSize(
      config.poolSize ?? process.env.SFTP_POOL_SIZE ?? DEFAULT_SFTP_POOL_SIZE
    );
    /** @type {Array<{ client: SftpClient, busy: boolean, id: number }>} */
    this._pool = [];
    this.connected = false;
    this.uploaded = 0;
    this.errors = [];
    /** @type {Array<() => void>} */
    this._waiters = [];
    this._ended = false;
  }

  async connect() {
    if (this.connected) return;
    const { host, port, username, password } = this.config;
    console.log(
      `[sftp] connecting ${username}@${host}:${port} ` +
        `(poolSize=${this.poolSize}) ...`
    );

    const slots = [];
    for (let i = 0; i < this.poolSize; i++) {
      const client = new SftpClient();
      await client.connect({
        host,
        port,
        username,
        password,
        readyTimeout: 60_000,
      });
      slots.push({ client, busy: false, id: i + 1 });
    }
    this._pool = slots;
    this.connected = true;
    console.log(
      `[sftp] connected; remote root: ${this.config.remoteRoot}; ` +
        `connections=${this.poolSize}`
    );
  }

  /**
   * Acquire a free pool connection (waits if all busy).
   * @returns {Promise<{ client: SftpClient, busy: boolean, id: number }>}
   */
  async _acquire() {
    await this.connect();
    for (;;) {
      if (this._ended) throw new Error('SFTP uploader has been closed');
      const free = this._pool.find((s) => !s.busy);
      if (free) {
        free.busy = true;
        return free;
      }
      await new Promise((resolve) => this._waiters.push(resolve));
    }
  }

  /** @param {{ client: SftpClient, busy: boolean, id: number }} slot */
  _release(slot) {
    slot.busy = false;
    const next = this._waiters.shift();
    if (next) next();
  }

  /**
   * Upload a local file (or Buffer) to remoteRoot/relativePath.
   * Up to `poolSize` uploads run concurrently.
   */
  async upload({ relativePath, localPath, buffer }) {
    const slot = await this._acquire();
    const remotePath = toPosix(
      path.posix.join(this.config.remoteRoot, toPosix(relativePath))
    );
    const remoteDir = path.posix.dirname(remotePath);

    try {
      await slot.client.mkdir(remoteDir, true);
      if (buffer) {
        await slot.client.put(buffer, remotePath);
      } else if (localPath) {
        await slot.client.put(localPath, remotePath);
      } else {
        throw new Error('upload requires localPath or buffer');
      }
      this.uploaded += 1;
      return { ok: true, remotePath, connectionId: slot.id };
    } catch (err) {
      this.errors.push({ relativePath, error: err.message });
      throw err;
    } finally {
      this._release(slot);
    }
  }

  async end() {
    this._ended = true;
    // Wake waiters so they fail cleanly
    while (this._waiters.length) {
      const w = this._waiters.shift();
      if (w) w();
    }
    // Wait briefly for busy slots to finish (best-effort)
    const deadline = Date.now() + 120_000;
    while (this._pool.some((s) => s.busy) && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 50));
    }
    for (const slot of this._pool) {
      try {
        await slot.client.end();
      } catch {
        // ignore close errors
      }
    }
    this._pool = [];
    this.connected = false;
    console.log(
      `[sftp] closed (uploaded=${this.uploaded} errors=${this.errors.length} poolSize=${this.poolSize})`
    );
  }
}

function toPosix(p) {
  return String(p).replace(/\\/g, '/');
}
