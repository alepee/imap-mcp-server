import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { AccountManager } from '../src/services/account-manager.js';
import { MemoryCredentialStore } from './helpers/credential-store.js';
import { writeLegacyAccounts } from './helpers/legacy-accounts.js';
import { accountTools } from '../src/tools/account-tools.js';

let vault: MemoryCredentialStore;
let dir: string;
let store: string;
beforeEach(() => {
  vault = new MemoryCredentialStore();
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'imap-store-transaction-'));
  store = path.join(dir, '.imap-mcp', 'accounts.json');
  vi.spyOn(os, 'homedir').mockReturnValue(dir);
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  fs.rmSync(dir, { recursive: true, force: true });
});
const fixture = (name: string) => ({ name, host: 'imap.example.invalid', port: 993,
  user: 'stored@example.invalid', password: 'synthetic-imap', tls: true,
  smtp: { host: 'smtp.example.invalid', port: 587, secure: false, user: 'stored-smtp@example.invalid', password: 'synthetic-smtp' },
});

describe('account store transactions', () => {
  it('preserves parallel additions, partial updates and deletions across existing instances', async () => {
    const first = new AccountManager({ credentialStore: vault });
    const second = new AccountManager({ credentialStore: vault });
    const created = await Promise.all(Array.from({ length: 8 }, (_, index) =>
      (index % 2 ? first : second).addAccount(fixture(`Account ${index}`))));
    expect(first.getAllAccounts()).toHaveLength(8);
    expect(second.getAccountByName('Account 0')?.id).toBe(created[0].id);
    await Promise.all([
      first.updateAccount(created[0].id, { name: 'Changed' }),
      second.updateAccount(created[0].id, { smtp: { port: 465 } }),
      second.removeAccount(created[1].id),
    ]);
    const fresh = new AccountManager({ credentialStore: vault });
    expect(fresh.getAllAccounts()).toHaveLength(7);
    expect(fresh.getAccount(created[0].id)).toMatchObject({ name: 'Changed', smtp: { port: 465, password: 'synthetic-smtp' } });
    expect(first.getAccount(created[1].id)).toBeUndefined();
  });

  it('serializes real child-process writers without losing updates', async () => {
    new AccountManager({ credentialStore: vault }); // establish the shared store before the writers start
    const writer = `
      import os from 'os';
      import { AccountManager } from './src/services/account-manager.ts';
      import { MemoryCredentialStore } from './tests/helpers/credential-store.ts';
      const vault = new MemoryCredentialStore();
      os.homedir = () => process.argv[1];
      const manager = new AccountManager({ credentialStore: vault });
      for (let i = 0; i < 5; i++) await manager.addAccount({
        name: process.argv[2] + i, host: 'imap.example.invalid', port: 993,
        user: 'fixture', password: 'fixture', tls: true,
      });
    `;
    await Promise.all(['first-', 'second-'].map(prefix => promisify(execFile)(process.execPath,
      ['--import', 'tsx', '--input-type=module', '-e', writer, dir, prefix], { cwd: process.cwd() })));
    expect(new AccountManager({ credentialStore: vault }).listAccountMetadata()).toHaveLength(10);
  });

  it('retains the old file and releases the lock when atomic replacement fails', async () => {
    const manager = new AccountManager({ credentialStore: vault });
    const account = await manager.addAccount(fixture('Original'));
    const before = fs.readFileSync(store, 'utf8');
    vi.spyOn(fs.promises, 'rename').mockRejectedValueOnce(new Error('simulated rename failure'));
    await expect(manager.updateAccount(account.id, { name: 'Lost' })).rejects.toThrow(/simulated/);
    expect(fs.readFileSync(store, 'utf8') === before).toBe(true);
    expect(fs.readdirSync(path.dirname(store)).sort()).toEqual(['accounts.json']);
    expect(manager.getAccount(account.id)?.name).toBe('Original');
    await manager.updateAccount(account.id, { name: 'Recovered' });
    expect(new AccountManager({ credentialStore: vault }).getAccount(account.id)?.name).toBe('Recovered');
  });

  it('does not replace the store on a partial temporary-file write', async () => {
    const manager = new AccountManager({ credentialStore: vault });
    await manager.addAccount(fixture('Original'));
    const before = fs.readFileSync(store, 'utf8');
    const open = fs.promises.open.bind(fs.promises);
    vi.spyOn(fs.promises, 'open').mockImplementationOnce((async (...args: Parameters<typeof fs.promises.open>) => {
      const handle = await open(...args);
      vi.spyOn(handle, 'writeFile').mockImplementationOnce(async () => {
        await handle.write('[');
        throw new Error('simulated full disk');
      });
      return handle;
    }) as typeof fs.promises.open);
    await expect(manager.addAccount(fixture('Lost'))).rejects.toThrow(/full disk/);
    expect(fs.readFileSync(store, 'utf8') === before).toBe(true);
    expect(fs.readdirSync(path.dirname(store)).sort()).toEqual(['accounts.json']);
  });

  it('fails closed on corrupt JSON without logging or overwriting its contents', async () => {
    const manager = new AccountManager({ credentialStore: vault });
    await manager.addAccount(fixture('Original'));
    fs.writeFileSync(store, '["synthetic-sensitive-fragment');
    const log = vi.spyOn(console, 'error');
    await expect(manager.addAccount(fixture('New'))).rejects.toThrow('Cannot read account store');
    expect(log).not.toHaveBeenCalled();
    expect(fs.readFileSync(store, 'utf8')).toBe('["synthetic-sensitive-fragment');
    expect(fs.existsSync(store + '.lock')).toBe(false);
  });

  it('times out on an existing lock without stealing or removing it', async () => {
    const manager = new AccountManager({ credentialStore: vault });
    fs.mkdirSync(store + '.lock', { recursive: true });
    let time = 0;
    vi.spyOn(Date, 'now').mockImplementation(() => time += 6000);
    await expect(manager.addAccount(fixture('Blocked'))).rejects.toThrow(/store is locked/);
    expect(fs.existsSync(store + '.lock')).toBe(true);
    expect(fs.existsSync(store)).toBe(false);
  });
});

describe('SMTP credential preservation', () => {
  it('keeps legacy environment credentials in the keychain after migrating a partial MCP update', async () => {
    writeLegacyAccounts(store, [{ ...fixture('WORK'), id: 'legacy' }]);
    vi.stubEnv('IMAP_MCP_ACCOUNT_WORK_SMTP_USERNAME', 'env-user');
    vi.stubEnv('IMAP_MCP_ACCOUNT_WORK_SMTP_PASSWORD', 'env-password');
    const manager = new AccountManager({ credentialStore: vault });
    const handlers = new Map<string, Function>();
    const imap = { disconnect: vi.fn() };
    const smtp = { disconnect: vi.fn() };
    accountTools({ registerTool: (name: string, _: unknown, handler: Function) => handlers.set(name, handler) } as any,
      manager, imap as any, smtp as any);
    await handlers.get('imap_update_account')!({ accountId: 'legacy', smtpPort: 465 });
    expect(manager.getAccount('legacy')?.smtp).toMatchObject({ user: 'env-user', password: 'env-password', port: 465 });
    expect(JSON.parse(fs.readFileSync(store, 'utf8'))[0].smtp.password).toBeUndefined();
    expect(imap.disconnect).toHaveBeenCalledWith('legacy');
    expect(smtp.disconnect).toHaveBeenCalledWith('legacy');
  });
});
