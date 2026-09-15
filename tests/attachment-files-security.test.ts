import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { attachmentPath, readAttachment, saveAttachment } from '../src/utils/attachment-files.js';
import { SmtpService } from '../src/services/smtp-service.js';
import { emailTools } from '../src/tools/email-tools.js';

let dir: string;
let root: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'imap-files-security-'));
  root = path.join(dir, 'downloads');
  fs.mkdirSync(root);
  vi.stubEnv('IMAP_DOWNLOAD_DIR', root);
});
afterEach(() => {
  vi.unstubAllEnvs();
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('attachment filesystem boundary', () => {
  it('rejects outside reads and writes, including sibling-prefix paths', () => {
    const outside = path.join(dir, 'downloads-other', 'file');
    expect(() => attachmentPath(outside, true)).toThrow(/inside IMAP_DOWNLOAD_DIR/);
    expect(() => saveAttachment('file', Buffer.from('new'), '../outside')).toThrow(/inside IMAP_DOWNLOAD_DIR/);
    expect(() => readAttachment('../outside')).toThrow(/inside IMAP_DOWNLOAD_DIR/);
    expect(fs.existsSync(path.dirname(outside))).toBe(false);
  });

  it('refuses explicit overwrites and keeps both default downloads', () => {
    const first = saveAttachment('../../invoice.txt', Buffer.from('first'));
    const second = saveAttachment('../../invoice.txt', Buffer.from('second'));
    expect(first).not.toBe(second);
    expect(readAttachment(first).toString()).toBe('first');
    expect(readAttachment(second).toString()).toBe('second');
    expect(() => saveAttachment('invoice.txt', Buffer.from('overwrite'), first)).toThrow();
    expect(readAttachment(first).toString()).toBe('first');
  });

  it.skipIf(process.platform === 'win32')('rejects symlink parents and final symlinks for both reads and writes', () => {
    fs.mkdirSync(path.join(dir, 'outside'));
    fs.writeFileSync(path.join(dir, 'outside', 'original'), 'unchanged');
    fs.symlinkSync(path.join(dir, 'outside'), path.join(root, 'escape'));
    fs.symlinkSync(path.join(dir, 'outside', 'original'), path.join(root, 'link'));
    for (const name of ['escape/original', 'escape/new/subdir/file', 'link']) {
      expect(() => readAttachment(name)).toThrow(/symlinks/);
      expect(() => saveAttachment('x', Buffer.from('bad'), name)).toThrow(/symlinks/);
    }
    expect(fs.readFileSync(path.join(dir, 'outside', 'original'), 'utf8')).toBe('unchanged');
    expect(fs.existsSync(path.join(dir, 'outside', 'new'))).toBe(false);
  });

  it('sends bytes from a valid uploaded path to the MIME composer', async () => {
    const smtp = new SmtpService();
    const local = saveAttachment('sample.txt', Buffer.from('attachment fixture'), 'uploads/sample.txt');
    const raw = await smtp.composeRaw(account, { to: 'to@example.invalid', subject: 'test', text: 'test',
      attachments: [{ filename: 'sample.txt', path: local }] });
    expect(raw.toString()).toContain(Buffer.from('attachment fixture').toString('base64'));
  });

  it('rejects URLs before SMTP connection or draft composition', async () => {
    const smtp = new SmtpService();
    const connect = vi.spyOn(smtp, 'createTransporter');
    for (const url of ['http://127.0.0.1/private', 'https://example.invalid/file', 'file:///etc/passwd']) {
      const mail = { to: 'to@example.invalid', subject: 'test', attachments: [{ filename: 'x', path: url }] };
      await expect(smtp.composeRaw(account, mail)).rejects.toThrow(/URLs/);
      await expect(smtp.sendEmail(account.id, account, mail)).rejects.toThrow(/URLs/);
    }
    expect(connect).not.toHaveBeenCalled();
  });

  it('enforces the boundary through the download and upload tools', async () => {
    const handlers = new Map<string, Function>();
    emailTools({ registerTool: (name: string, _: unknown, handler: Function) => handlers.set(name, handler) } as any,
      { getAttachmentContent: async () => ({ content: Buffer.from('fixture'), contentType: 'text/plain', filename: 'file.txt' }) } as any,
      { resolveAccountId: () => 'a' } as any, {} as any);
    await expect(handlers.get('imap_download_attachment')!({ uid: 1, filename: 'file.txt', savePath: '../escape', extractText: false }))
      .rejects.toThrow(/inside IMAP_DOWNLOAD_DIR/);
    const result = await handlers.get('imap_upload_file')!({ filename: '../../sample.txt', content: Buffer.from('uploaded').toString('base64') });
    const saved = JSON.parse(result.content[0].text);
    expect(readAttachment(saved.path).toString()).toBe('uploaded');
  });
});

const account = { id: 'test', name: 'Test', host: 'imap.example.invalid', port: 993, user: 'user@example.invalid', password: 'fixture', tls: true };
