import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { AccountManager } from '../src/services/account-manager.js';
import { accountTools } from '../src/tools/account-tools.js';

let dir: string;
let store: string;
beforeEach(() => {
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
    const first = new AccountManager();
    const second = new AccountManager();
    const created = await Promise.all(Array.from({ length: 8 }, (_, index) =>
      (index % 2 ? first : second).addAccount(fixture(`Account ${index}`))));
    expect(first.getAllAccounts()).toHaveLength(8);
    expect(second.getAccountByName('Account 0')?.id).toBe(created[0].id);
    await Promise.all([
      first.updateAccount(created[0].id, { name: 'Changed' }),
      second.updateAccount(created[0].id, { smtp: { port: 465 } }),
      second.removeAccount(created[1].id),
    ]);
    const fresh = new AccountManager();
    expect(fresh.getAllAccounts()).toHaveLength(7);
    expect(fresh.getAccount(created[0].id)).toMatchObject({ name: 'Changed', smtp: { port: 465, password: 'synthetic-smtp' } });
    expect(first.getAccount(created[1].id)).toBeUndefined();
  });

  it('serializes real child-process writers without losing updates', async () => {
    new AccountManager(); // establish the shared key before the writers start
    const writer = `
      import os from 'os';
      import { AccountManager } from './src/services/account-manager.ts';
      os.homedir = () => process.argv[1];
      const manager = new AccountManager();
      for (let i = 0; i < 5; i++) await manager.addAccount({
        name: process.argv[2] + i, host: 'imap.example.invalid', port: 993,
        user: 'fixture', password: 'fixture', tls: true,
      });
    `;
    await Promise.all(['first-', 'second-'].map(prefix => promisify(execFile)(process.execPath,
      ['--import', 'tsx', '--input-type=module', '-e', writer, dir, prefix], { cwd: process.cwd() })));
    expect(new AccountManager().getAllAccounts()).toHaveLength(10);
  });

  it('retains the old file and releases the lock when atomic replacement fails', async () => {
    const manager = new AccountManager();
    const account = await manager.addAccount(fixture('Original'));
    const before = fs.readFileSync(store, 'utf8');
    vi.spyOn(fs.promises, 'rename').mockRejectedValueOnce(new Error('simulated rename failure'));
    await expect(manager.updateAccount(account.id, { name: 'Lost' })).rejects.toThrow(/simulated/);
    expect(fs.readFileSync(store, 'utf8') === before).toBe(true);
    expect(fs.readdirSync(path.dirname(store)).sort()).toEqual(['.key', 'accounts.json']);
    expect(manager.getAccount(account.id)?.name).toBe('Original');
    await manager.updateAccount(account.id, { name: 'Recovered' });
    expect(new AccountManager().getAccount(account.id)?.name).toBe('Recovered');
  });

  it('does not replace the store on a partial temporary-file write', async () => {
    const manager = new AccountManager();
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
    expect(fs.readdirSync(path.dirname(store)).sort()).toEqual(['.key', 'accounts.json']);
  });

  it('fails closed on corrupt JSON without logging or overwriting its contents', async () => {
    const manager = new AccountManager();
    await manager.addAccount(fixture('Original'));
    fs.writeFileSync(store, '["synthetic-sensitive-fragment');
    const log = vi.spyOn(console, 'error');
    await expect(manager.addAccount(fixture('New'))).rejects.toThrow('Cannot read account store');
    expect(log).not.toHaveBeenCalled();
    expect(fs.readFileSync(store, 'utf8')).toBe('["synthetic-sensitive-fragment');
    expect(fs.existsSync(store + '.lock')).toBe(false);
  });

  it('does not regenerate a missing or invalid key for an existing store', async () => {
    const manager = new AccountManager();
    await manager.addAccount(fixture('Original'));
    const keyPath = path.join(path.dirname(store), '.key');
    fs.unlinkSync(keyPath);
    expect(() => new AccountManager()).toThrow(/key is missing/);
    expect(fs.existsSync(keyPath)).toBe(false);
    fs.writeFileSync(keyPath, 'invalid');
    expect(() => new AccountManager()).toThrow(/Invalid encryption key/);
    expect(fs.readFileSync(keyPath, 'utf8')).toBe('invalid');
  });

  it('times out on an existing lock without stealing or removing it', async () => {
    const manager = new AccountManager();
    fs.mkdirSync(store + '.lock');
    let time = 0;
    vi.spyOn(Date, 'now').mockImplementation(() => time += 6000);
    await expect(manager.addAccount(fixture('Blocked'))).rejects.toThrow(/store is locked/);
    expect(fs.existsSync(store + '.lock')).toBe(true);
    expect(fs.existsSync(store)).toBe(false);
  });
});

describe('SMTP credential preservation', () => {
  it('keeps stored credentials and env placeholders on MCP updates without persisting overrides', async () => {
    vi.stubEnv('IMAP_MCP_ACCOUNT_WORK_SMTP_USERNAME', 'env-user');
    vi.stubEnv('IMAP_MCP_ACCOUNT_WORK_SMTP_PASSWORD', 'env-password');
    const manager = new AccountManager();
    const account = await manager.addAccount(fixture('WORK'));
    const handlers = new Map<string, Function>();
    const imap = { disconnect: vi.fn() };
    const smtp = { disconnect: vi.fn() };
    accountTools({ registerTool: (name: string, _: unknown, handler: Function) => handlers.set(name, handler) } as any,
      manager, imap as any, smtp as any);
    const update = handlers.get('imap_update_account')!;
    await update({ accountId: account.id, smtpPort: 465 });
    expect(manager.getAccount(account.id)?.smtp).toMatchObject({ user: 'env-user', password: 'env-password', port: 465 });
    // A new manager has no captured overrides and exposes the original stored credentials.
    expect(new AccountManager().getAccount(account.id)?.smtp).toMatchObject({ user: 'stored-smtp@example.invalid', password: 'synthetic-smtp', port: 465 });
    await manager.updateAccount(account.id, { smtp: { user: '', password: '' } });
    await update({ accountId: account.id, smtpPort: 587 });
    expect(new AccountManager().getAccount(account.id)?.smtp).toMatchObject({ user: '', password: '', port: 587 });
    expect(imap.disconnect).toHaveBeenCalledWith(account.id);
    expect(smtp.disconnect).toHaveBeenCalledWith(account.id);
  });

  it('preserves absent fields, but encrypts explicit replacement or empty SMTP passwords', async () => {
    const manager = new AccountManager();
    const created = await manager.addAccount(fixture('Original'));
    await manager.updateAccount(created.id, { smtp: { secure: true } });
    expect(manager.getAccount(created.id)?.smtp?.password).toBe('synthetic-smtp');
    await manager.updateAccount(created.id, { smtp: { password: 'replacement' } });
    expect(manager.getAccount(created.id)?.smtp?.password).toBe('replacement');
    await manager.updateAccount(created.id, { smtp: { password: '' } });
    const stored = JSON.parse(fs.readFileSync(store, 'utf8'))[0];
    expect(stored.smtp.password).toContain(':');
    expect(manager.getAccount(created.id)?.smtp?.password).toBe('');
  });
});
