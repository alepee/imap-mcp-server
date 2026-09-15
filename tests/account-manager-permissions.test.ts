import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { promises as fsp, statSync } from 'fs';
import path from 'path';
import os from 'os';
import { vi } from 'vitest';
import { MemoryCredentialStore } from './helpers/credential-store.js';

// Metadata and its directory must remain owner-only. POSIX-only.
const runOnPosix = process.platform === 'win32' ? describe.skip : describe;

runOnPosix('AccountManager credential-store permissions', () => {
  let tmpHome: string;

  beforeEach(async () => {
    tmpHome = await fsp.mkdtemp(path.join(os.tmpdir(), 'imap-mcp-perms-'));
    // AccountManager derives ~/.imap-mcp from os.homedir(), which honours $HOME.
    vi.spyOn(os, 'homedir').mockReturnValue(tmpHome);
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await fsp.rm(tmpHome, { recursive: true, force: true });
  });

  it('writes reference-only accounts.json owner-only without creating a local encryption key', async () => {
    const { AccountManager } = await import('../src/services/account-manager.js');
    const manager = new AccountManager({ credentialStore: new MemoryCredentialStore() });

    await manager.addAccount({
      name: 'Test',
      host: 'imap.test.com',
      port: 993,
      user: 'user@test.com',
      password: 'topsecret',
      tls: true,
    });

    const dir = path.join(tmpHome, '.imap-mcp');
    const mode = (p: string) => statSync(p).mode & 0o777;

    await expect(fsp.stat(path.join(dir, '.key'))).rejects.toMatchObject({ code: 'ENOENT' });
    expect(mode(path.join(dir, 'accounts.json'))).toBe(0o600);
    expect(mode(dir)).toBe(0o700);
  });
});
