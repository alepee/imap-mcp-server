import fs from 'fs';
import path from 'path';
import os from 'os';
import { randomUUID } from 'crypto';

export function attachmentRoot(): string {
  return path.resolve(process.env.IMAP_DOWNLOAD_DIR || path.join(os.homedir(), 'Downloads', 'imap-attachments'));
}

/** Resolve beneath the configured root, rejecting symlinks in child paths. */
export function attachmentPath(input: string, createParents = false): string {
  if (/^[a-z][a-z\d+.-]*:/i.test(input) && !/^[a-z]:[\\/]/i.test(input)) {
    throw new Error('Attachment URLs are not allowed; use imap_upload_file or a local file in IMAP_DOWNLOAD_DIR.');
  }
  const root = attachmentRoot();
  if (createParents) fs.mkdirSync(root, { recursive: true, mode: 0o700 });
  const canonicalRoot = fs.realpathSync(root);
  const candidate = path.resolve(root, input);
  const inside = (relative: string) => relative !== '' && relative !== '..'
    && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative);
  let relative = path.relative(root, candidate);
  if (!inside(relative)) relative = path.relative(canonicalRoot, candidate);
  if (!inside(relative)) throw new Error('Attachment path must be inside IMAP_DOWNLOAD_DIR.');
  // The configured root may itself be a symlink (e.g. macOS /tmp). Everything
  // beneath its canonical location must be a real directory or regular file.
  let current = canonicalRoot;
  const parts = relative.split(path.sep);
  for (let i = 0; i < parts.length; i++) {
    current = path.join(current, parts[i]);
    const parent = i < parts.length - 1;
    try {
      const stat = fs.lstatSync(current);
      if (stat.isSymbolicLink() || (parent ? !stat.isDirectory() : !stat.isFile())) {
        throw new Error('Attachment paths must not contain symlinks or special files.');
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      if (parent) {
        if (!createParents) throw error;
        fs.mkdirSync(current, { mode: 0o700 });
      }
    }
  }
  return current;
}

export function readAttachment(input: string): Buffer {
  const target = attachmentPath(input);
  const fd = fs.openSync(target, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0) | (fs.constants.O_NONBLOCK || 0));
  try {
    if (!fs.fstatSync(fd).isFile()) throw new Error('Attachment must be a regular file.');
    return fs.readFileSync(fd);
  } finally {
    fs.closeSync(fd);
  }
}

export function saveAttachment(filename: string, content: Buffer, savePath?: string): string {
  const basename = path.basename(filename.replace(/\\/g, '/'));
  const safeName = !basename || basename === '.' || basename === '..' ? 'attachment' : basename;
  let target = attachmentPath(savePath ?? safeName, true);
  for (;;) {
    try {
      // Exclusive creation rejects both existing files and final symlinks.
      fs.writeFileSync(target, content, { flag: 'wx', mode: 0o600 });
      return target;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST' || savePath) throw error;
      target = attachmentPath(`${randomUUID()}-${safeName}`, true);
    }
  }
}
