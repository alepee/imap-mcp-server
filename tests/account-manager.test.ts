import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { AccountManager } from '../src/services/account-manager.js';
import { MemoryCredentialStore } from './helpers/credential-store.js';
import { writeLegacyAccounts } from './helpers/legacy-accounts.js';

let dir: string;
let configPath: string;
let vault: MemoryCredentialStore;
const fixture = { id: 'legacy', name: 'Work', host: 'imap.example.invalid', port: 993, tls: true,
  user: 'user@example.invalid', password: 'synthetic-imap',
  smtp: { host: 'smtp.example.invalid', port: 587, secure: false, user: 'smtp-user', password: 'synthetic-smtp' },
};
const manager = () => new AccountManager({ configPath, credentialStore: vault });
const stored = () => JSON.parse(fs.readFileSync(configPath, 'utf8'));
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'imap-keychain-manager-'));
  configPath = path.join(dir, 'accounts.json');
  vault = new MemoryCredentialStore();
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('system keychain account lifecycle', () => {
  it('creates no local encryption key and stores only secret references', async () => {
    const service = manager();
    const created = await service.addAccount(fixture);
    expect(service.getAccount(created.id)).toMatchObject(fixtureWithoutId());
    const record = stored()[0];
    expect(record.credentialRef).toMatch(/^[a-f0-9-]{36}$/);
    expect(record.password).toBeUndefined();
    expect(record.smtp.password).toBeUndefined();
    expect(fs.existsSync(path.join(dir, '.key'))).toBe(false);
    expect(vault.entries.size).toBe(1);
  });

  it('preserves absent SMTP credentials, rotates references and deletes retired secrets', async () => {
    const service = manager();
    const created = await service.addAccount(fixture);
    const originalRef = stored()[0].credentialRef;
    await service.updateAccount(created.id, { name: 'Renamed', smtp: { port: 465 } });
    expect(service.getAccount(created.id)).toMatchObject({ name: 'Renamed', password: fixture.password, smtp: { password: fixture.smtp.password, port: 465 } });
    expect(stored()[0].credentialRef).not.toBe(originalRef);
    expect(vault.get(originalRef)).toBeNull();
    expect(vault.entries.size).toBe(1);
  });

  it('replaces passwords without writing either value into configuration', async () => {
    const service = manager();
    const created = await service.addAccount(fixture);
    await service.updateAccount(created.id, { password: 'new-fixture', smtp: { password: 'new-smtp-fixture' } });
    expect(service.getAccount(created.id)).toMatchObject({ password: 'new-fixture', smtp: { password: 'new-smtp-fixture' } });
    expect(fs.readFileSync(configPath, 'utf8')).not.toContain('new-fixture');
  });

  it('retains IMAP fallback when SMTP has no separate password', async () => {
    const service = manager();
    const created = await service.addAccount({ ...fixture, smtp: { host: 'smtp.example.invalid', port: 587, secure: false } });
    await service.updateAccount(created.id, { smtp: { port: 465 } });
    expect(service.getAccount(created.id)?.smtp?.password).toBeUndefined();
    expect(service.getAccount(created.id)?.password).toBe(fixture.password);
  });

  it('removes references and keychain secrets when removing accounts', async () => {
    const service = manager();
    const created = await service.addAccount(fixture);
    await service.removeAccount(created.id);
    expect(service.getAccount(created.id)).toBeUndefined();
    expect(vault.entries.size).toBe(0);
    expect(stored()).toEqual([]);
  });

  it('lists metadata without reading the keychain', async () => {
    const service = manager();
    const created = await service.addAccount(fixture);
    const get = vi.spyOn(vault, 'get').mockImplementation(() => { throw new Error('locked'); });
    expect(service.listAccountMetadata()[0]).toMatchObject({ id: created.id, credentialStorage: 'system' });
    expect(service.getAccountMetadata(created.id)?.smtp).not.toHaveProperty('password');
    expect(service.getAccountMetadata(created.id)).not.toHaveProperty('credentialRef');
    expect(get).not.toHaveBeenCalled();
  });

  it('reports a missing entry instead of dialing with blank credentials', async () => {
    const service = manager();
    const created = await service.addAccount(fixture);
    vault.entries.clear();
    expect(() => service.getAccount(created.id)).toThrow(/missing from the system keychain/);
  });

  it.each([{ user: '' }, { password: '' }, { smtp: { ...fixture.smtp, password: '' } }])('rejects unresolved credentials: %j', async fields => {
    await expect(manager().addAccount({ ...fixture, ...fields })).rejects.toThrow(/missing username or password/);
    expect(vault.entries.size).toBe(0);
    expect(fs.existsSync(configPath)).toBe(false);
  });

  it('ignores environment overrides for system-keychain accounts', async () => {
    vi.stubEnv('IMAP_MCP_ACCOUNT_WORK_IMAP_PASSWORD', 'ambient-override');
    const service = manager();
    const created = await service.addAccount(fixture);
    expect(service.getAccount(created.id)?.password).toBe(fixture.password);
    expect(process.env.IMAP_MCP_ACCOUNT_WORK_IMAP_PASSWORD).toBeUndefined();
  });

  it('resolves accounts by id, name and an unambiguous default', async () => {
    const service = manager();
    expect(() => service.resolveAccountId()).toThrow(/No accounts/);
    const created = await service.addAccount(fixture);
    expect(service.resolveAccountId()).toBe(created.id);
    expect(service.resolveAccountId(created.id)).toBe(created.id);
    expect(service.resolveAccountId(undefined, 'Work')).toBe(created.id);
    expect(service.getAccountByName('Work')?.id).toBe(created.id);
    expect(service.getAllAccounts()).toHaveLength(1);
    expect(service.getAccountByName('Missing')).toBeUndefined();
    expect(() => service.resolveAccountId('Missing')).toThrow(/not found/);
    expect(() => service.resolveAccountId(undefined, 'Missing')).toThrow(/No account named/);
    await service.addAccount({ ...fixture, name: 'Other' });
    expect(() => service.resolveAccountId()).toThrow(/Multiple accounts/);
  });

  it('refuses updates and removals of nonexistent accounts', async () => {
    await expect(manager().updateAccount('none', { name: 'x' })).rejects.toThrow(/not found/);
    await expect(manager().removeAccount('none')).rejects.toThrow(/not found/);
  });
});

function fixtureWithoutId() { const { id: _id, ...rest } = fixture; return rest; }

describe('legacy migration', () => {
  it('reads legacy accounts without modifying them, then verifies and migrates all passwords', async () => {
    writeLegacyAccounts(configPath, [fixture, { ...fixture, id: 'second', name: 'Other' }]);
    const before = fs.readFileSync(configPath, 'utf8');
    const service = manager();
    expect(service.getAccount('legacy')).toMatchObject(fixture);
    expect(fs.readFileSync(configPath, 'utf8')).toBe(before);
    expect(service.listAccountMetadata()[0].credentialStorage).toBe('legacy');
    expect(await service.migrateCredentials()).toEqual({ migrated: 2 });
    expect(service.getAccount('legacy')).toMatchObject(fixture);
    expect(stored().every((record: any) => record.credentialRef && !record.password && !record.smtp.password)).toBe(true);
    expect(fs.existsSync(path.join(dir, '.key'))).toBe(false);
    expect(await service.migrateCredentials()).toEqual({ migrated: 0 });
    expect(vault.entries.size).toBe(2);
  });

  it('migrates a single account on edit but preserves the legacy key for remaining accounts', async () => {
    writeLegacyAccounts(configPath, [fixture, { ...fixture, id: 'second' }]);
    const service = manager();
    await service.updateAccount('legacy', { name: 'Renamed' });
    expect(service.getAccount('legacy')?.password).toBe(fixture.password);
    expect(service.getAccount('second')?.password).toBe(fixture.password);
    expect(fs.existsSync(path.join(dir, '.key'))).toBe(true);
  });

  it('imports legacy environment values once and ignores subsequent overrides', async () => {
    writeLegacyAccounts(configPath, [{ ...fixture, password: '', user: '' }]);
    vi.stubEnv('IMAP_MCP_ACCOUNT_WORK_IMAP_PASSWORD', 'legacy-env-fixture');
    vi.stubEnv('IMAP_MCP_ACCOUNT_WORK_IMAP_USERNAME', 'env-user');
    const service = manager();
    await service.migrateCredentials();
    vi.stubEnv('IMAP_MCP_ACCOUNT_WORK_IMAP_PASSWORD', 'new-ambient-value');
    expect(manager().getAccount('legacy')).toMatchObject({ password: 'legacy-env-fixture', user: 'env-user' });
  });

  it('retains the entire old file and key if any account cannot be migrated', async () => {
    writeLegacyAccounts(configPath, [fixture, { ...fixture, id: 'missing', name: 'Missing', password: '' }]);
    const before = fs.readFileSync(configPath, 'utf8');
    await expect(manager().migrateCredentials()).rejects.toThrow(/missing username or password/);
    expect(fs.readFileSync(configPath, 'utf8')).toBe(before);
    expect(fs.existsSync(path.join(dir, '.key'))).toBe(true);
    expect(vault.entries.size).toBe(0);
  });

  it('rolls back migration when read-back verification fails', async () => {
    writeLegacyAccounts(configPath, [fixture]);
    const before = fs.readFileSync(configPath, 'utf8');
    vi.spyOn(vault, 'get').mockReturnValue('incorrect read-back');
    await expect(manager().migrateCredentials()).rejects.toThrow(/could not verify/);
    expect(fs.readFileSync(configPath, 'utf8')).toBe(before);
    expect(fs.existsSync(path.join(dir, '.key'))).toBe(true);
    expect(vault.entries.size).toBe(0);
  });

  it('retains legacy copies and cleans new entries if the JSON commit fails', async () => {
    writeLegacyAccounts(configPath, [fixture]);
    const before = fs.readFileSync(configPath, 'utf8');
    vi.spyOn(fs.promises, 'rename').mockRejectedValueOnce(new Error('simulated disk failure'));
    await expect(manager().migrateCredentials()).rejects.toThrow(/disk failure/);
    expect(fs.readFileSync(configPath, 'utf8')).toBe(before);
    expect(fs.existsSync(path.join(dir, '.key'))).toBe(true);
    expect(vault.entries.size).toBe(0);
  });

  it('never replaces a missing or corrupt legacy key', () => {
    writeLegacyAccounts(configPath, [fixture]);
    const keyPath = path.join(dir, '.key');
    fs.unlinkSync(keyPath);
    expect(manager().listAccountMetadata()).toHaveLength(1);
    expect(() => manager().getAccount('legacy')).toThrow(/Restore the original .key/);
    expect(fs.existsSync(keyPath)).toBe(false);
    fs.writeFileSync(keyPath, 'invalid');
    expect(() => manager().getAccount('legacy')).toThrow(/Restore the original .key/);
    expect(fs.readFileSync(keyPath, 'utf8')).toBe('invalid');
  });
});
