import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import type { Server } from 'http';
import type { AddressInfo } from 'net';
import { WebUIServer } from '../src/web/server.js';
import { writeLegacyAccounts } from './helpers/legacy-accounts.js';
import { MemoryCredentialStore } from './helpers/credential-store.js';
import { AccountManager } from '../src/services/account-manager.js';

let dir: string;
let server: Server;
let manager: AccountManager;
let id: string;
let url: string;
beforeEach(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'imap-wizard-credentials-'));
  vi.spyOn(os, 'homedir').mockReturnValue(dir);
  manager = new AccountManager({ credentialStore: new MemoryCredentialStore() });
  const account = await manager.addAccount({ name: 'Work', host: 'imap.example.invalid', port: 993, tls: true,
    user: 'fixture', password: 'synthetic-imap',
    smtp: { host: 'smtp.example.invalid', port: 587, secure: false, user: 'smtp-fixture', password: 'synthetic-smtp' },
  });
  id = account.id;
  const wizard = new WebUIServer(0, { accountManager: manager, imapService: { disconnect: vi.fn() } as any });
  await new Promise<void>((resolve, reject) => {
    server = wizard.getApp().listen(0, '127.0.0.1', resolve);
    server.on('error', reject);
  });
  url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/accounts/${id}`;
});
afterEach(async () => {
  if (server?.listening) await new Promise<void>(resolve => server.close(() => resolve()));
  vi.restoreAllMocks();
  fs.rmSync(dir, { recursive: true, force: true });
});
async function update(body: unknown) {
  const response = await fetch(url, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  expect(response.status).toBe(200);
  const result = await response.json();
  expect(result.account.password).toBeUndefined();
  expect(result.account.smtp.password).toBeUndefined();
}

it('preserves blank wizard passwords and omitted SMTP fields on edit', async () => {
  await update({ name: 'Renamed', password: '', smtp: { port: 465, password: '' } });
  expect(manager.getAccount(id)).toMatchObject({ name: 'Renamed', password: 'synthetic-imap',
    smtp: { host: 'smtp.example.invalid', port: 465, user: 'smtp-fixture', password: 'synthetic-smtp' } });
});

it('accepts explicit password replacements and rejects obsolete env-management flags', async () => {
  await update({ password: 'replacement-imap', smtp: { password: 'replacement-smtp' } });
  expect(manager.getAccount(id)).toMatchObject({ password: 'replacement-imap', smtp: { password: 'replacement-smtp' } });
  const response = await fetch(url, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ imapPasswordFromEnv: true }) });
  expect(response.status).toBe(400);
  expect(manager.getAccount(id)?.password).toBe('replacement-imap');
});

it('migrates legacy passwords through the wizard without exposing secrets or references', async () => {
  const configPath = path.join(dir, '.imap-mcp', 'accounts.json');
  writeLegacyAccounts(configPath, [{ id: 'legacy', name: 'Old', host: 'imap.example.invalid', port: 993, tls: true, user: 'fixture', password: 'legacy-synthetic' }]);
  const base = url.split('/api/')[0];
  expect(await (await fetch(base + '/api/credential-storage')).json()).toMatchObject({ legacyAccounts: 1 });
  const response = await fetch(base + '/api/accounts/migrate-credentials', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
  expect(await response.json()).toEqual({ success: true, migrated: 1 });
  expect(manager.getAccount('legacy')?.password).toBe('legacy-synthetic');
  expect(fs.existsSync(path.join(dir, '.imap-mcp', '.key'))).toBe(false);
  const metadata = await (await fetch(base + '/api/accounts/legacy')).json();
  expect(JSON.stringify(metadata)).not.toMatch(/legacy-synthetic|credentialRef|password/);
  expect(await (await fetch(base + '/api/credential-storage')).json()).toMatchObject({ legacyAccounts: 0 });
});
