import { promises as fs } from 'fs';
import { readFileSync } from 'fs';
import path from 'path';
import os from 'os';
import crypto from 'crypto';
import { ImapAccount, SmtpConfig } from '../types/index.js';
import { ENV_CREDENTIAL_SUFFIXES, envVarName } from '../utils/env-credentials.js';
import { CredentialStore, SystemCredentialStore } from './credential-store.js';

export type AccountUpdates = Partial<Omit<ImapAccount, 'id' | 'smtp'>> & { smtp?: Partial<SmtpConfig> };

type StoredAccount = Omit<ImapAccount, 'password'> & { password?: string; credentialRef?: string };
type Passwords = { imap: string; smtp?: string };

export class AccountManager {
  private configPath: string;
  private accounts: Map<string, StoredAccount> = new Map();
  // Only legacy environment values use this ephemeral in-memory key.
  private encryptionKey = crypto.randomBytes(32).toString('hex');
  private credentialStore: CredentialStore;
  private capturedEnvOverrides: Map<string, string> = new Map();

  private static readonly ENV_OVERRIDE_PATTERN =
    /^IMAP_MCP_ACCOUNT_.+_(?:IMAP|SMTP)_(?:USERNAME|PASSWORD)$/;

  constructor(options: { credentialStore?: CredentialStore; configPath?: string } = {}) {
    this.configPath = options.configPath ?? path.join(os.homedir(), '.imap-mcp', 'accounts.json');
    this.credentialStore = options.credentialStore ?? new SystemCredentialStore();
    this.captureEnvOverrides();
    this.loadAccountsSync();
  }

  async addAccount(account: Omit<ImapAccount, 'id'>): Promise<ImapAccount> {
    const created = { ...account, id: crypto.randomUUID() };
    await this.transaction((accounts, createdRefs) => {
      accounts.set(created.id, this.storeAccount(created, createdRefs));
    });
    return created;
  }

  async removeAccount(id: string): Promise<void> {
    await this.transaction(accounts => {
      if (!accounts.delete(id)) throw new Error(`Account ${id} not found`);
    });
  }

  async updateAccount(id: string, updates: AccountUpdates): Promise<ImapAccount> {
    return this.transaction((accounts, createdRefs) => {
      const stored = accounts.get(id);
      if (!stored) throw new Error(`Account with id ${id} not found`);
      const existing = this.resolveCredentials(stored);
      const { smtp, ...fields } = updates;
      const next: ImapAccount = { ...existing, ...fields, id };
      if (smtp !== undefined) {
        next.smtp = {
          host: existing.host, port: 587, secure: false,
          ...existing.smtp, ...Object.fromEntries(Object.entries(smtp).filter(([, value]) => value !== undefined)),
        };
      }
      // Every mutation uses a new, verified reference. A failed JSON commit
      // cannot overwrite the secrets still referenced by the previous file.
      accounts.set(id, this.storeAccount(next, createdRefs));
      return next;
    });
  }

  /** Metadata-only reads do not touch the keychain, including in the wizard. */
  listAccountMetadata() {
    return Array.from(this.readAccounts().values()).map(account => this.metadata(account));
  }

  getAccountMetadata(id: string) {
    const account = this.readAccounts().get(id);
    return account ? this.metadata(account) : undefined;
  }

  private metadata(account: StoredAccount) {
    const { password: _password, credentialRef, smtp, ...rest } = account;
    const { password: _smtpPassword, ...smtpMetadata } = smtp ?? {};
    return { ...rest, ...(smtp ? { smtp: smtpMetadata } : {}),
      credentialStorage: credentialRef ? 'system' as const : 'legacy' as const };
  }

  getAccount(id: string): ImapAccount | undefined {
    const account = this.readAccounts().get(id);
    if (!account) return undefined;
    try {
      return this.resolveCredentials(account);
    } catch (error) {
      // Another process may have committed a replacement and retired the old
      // reference between our config read and keychain lookup. Retry once.
      const latest = this.readAccounts().get(id);
      if (latest && latest.credentialRef !== account.credentialRef) return this.resolveCredentials(latest);
      throw error;
    }
  }

  private resolveCredentials(account: StoredAccount): ImapAccount {
    const { credentialRef, ...rest } = account;
    if (credentialRef) {
      const raw = this.credentialStore.get(credentialRef);
      if (raw === null) throw new Error('Saved passwords are missing from the system keychain. Restore the entry or remove and recreate this account in the setup wizard.');
      let passwords: Passwords;
      try {
        passwords = JSON.parse(raw);
        if (typeof passwords?.imap !== 'string' || (passwords.smtp !== undefined && typeof passwords.smtp !== 'string')) throw new Error();
      } catch {
        throw new Error('The saved keychain entry is invalid. Restore it or recreate this account.');
      }
      return { ...rest, password: passwords.imap,
        ...(rest.smtp ? { smtp: { ...rest.smtp, ...(passwords.smtp !== undefined ? { password: passwords.smtp } : {}) } } : {}),
      };
    }
    return this.applyEnvOverrides({ ...rest, password: this.decryptLegacyField(rest.password),
      ...(rest.smtp ? { smtp: { ...rest.smtp,
        ...(rest.smtp.password !== undefined ? { password: this.decryptLegacyField(rest.smtp.password) } : {}),
      } } : {}),
    });
  }

  private storeAccount(account: ImapAccount, createdRefs: string[]): StoredAccount {
    if (!account.user || !account.password || account.smtp?.user === '' || account.smtp?.password === '') {
      throw new Error(`Enter the missing username or password for account "${account.name}" in the setup wizard before saving it to the system keychain.`);
    }
    const credentialRef = crypto.randomUUID();
    const passwords: Passwords = { imap: account.password,
      ...(account.smtp?.password !== undefined ? { smtp: account.smtp.password } : {}),
    };
    const serialized = JSON.stringify(passwords);
    // Track before set: even a partially failing native write may create an entry.
    createdRefs.push(credentialRef);
    this.credentialStore.set(credentialRef, serialized);
    if (this.credentialStore.get(credentialRef) !== serialized) {
      throw new Error('The system keychain could not verify the saved passwords. Your previous configuration is unchanged.');
    }
    const { password: _password, smtp, ...rest } = account;
    const { password: _smtpPassword, ...smtpSettings } = smtp ?? {};
    return { ...rest, ...(smtp ? { smtp: smtpSettings as SmtpConfig } : {}), credentialRef };
  }

  /** Explicit wizard action: all legacy entries migrate, or none are published. */
  async migrateCredentials(): Promise<{ migrated: number }> {
    return this.transaction((accounts, createdRefs) => {
      let migrated = 0;
      for (const [id, account] of accounts) {
        if (account.credentialRef) continue;
        accounts.set(id, this.storeAccount(this.resolveCredentials(account), createdRefs));
        migrated++;
      }
      return { migrated };
    });
  }

  /**
   * Override IMAP/SMTP credentials from environment variables, keyed by the
   * account's normalized name. Only used for legacy accounts until migration; native accounts ignore these.
   *
   *   IMAP_MCP_ACCOUNT_<NAME>_IMAP_USERNAME  -> user
   *   IMAP_MCP_ACCOUNT_<NAME>_IMAP_PASSWORD  -> password
   *   IMAP_MCP_ACCOUNT_<NAME>_SMTP_USERNAME  -> smtp.user  (only if smtp exists)
   *   IMAP_MCP_ACCOUNT_<NAME>_SMTP_PASSWORD  -> smtp.password (only if smtp exists)
   *
   * <NAME> is the account name uppercased with every non-alphanumeric character
   * replaced by "_". Overrides are applied in-memory only; nothing is written
   * back to disk. A variable takes effect only when it was present at startup.
   *
   * The values themselves are captured once in the constructor (see
   * `captureEnvOverrides`) and served here from the encrypted cache.
   */
  private applyEnvOverrides(account: ImapAccount): ImapAccount {
    const varName = (suffix: string) => envVarName(account.name, suffix);

    const result: ImapAccount = { ...account };

    const imapUser = this.getEnvOverride(varName(ENV_CREDENTIAL_SUFFIXES.imapUser));
    if (imapUser !== undefined) {
      result.user = imapUser;
    }

    const imapPassword = this.getEnvOverride(varName(ENV_CREDENTIAL_SUFFIXES.imapPassword));
    if (imapPassword !== undefined) {
      result.password = imapPassword;
    }

    if (result.smtp) {
      const smtpUser = this.getEnvOverride(varName(ENV_CREDENTIAL_SUFFIXES.smtpUser));
      const smtpPassword = this.getEnvOverride(varName(ENV_CREDENTIAL_SUFFIXES.smtpPassword));

      if (smtpUser !== undefined || smtpPassword !== undefined) {
        result.smtp = { ...result.smtp };
        if (smtpUser !== undefined) {
          result.smtp.user = smtpUser;
        }
        if (smtpPassword !== undefined) {
          result.smtp.password = smtpPassword;
        }
      }
    }

    return result;
  }

  /**
   * Capture every `IMAP_MCP_ACCOUNT_*_(IMAP|SMTP)_(USERNAME|PASSWORD)` variable
   * into an encrypted in-memory cache and delete it from `process.env`. Run once
   * in the constructor so the plaintext secrets do not linger in the process
   * environment (where they could leak to child processes or diagnostics) any
   * longer than necessary. `Object.entries` snapshots the keys, so deleting
   * during iteration is safe.
   */
  private captureEnvOverrides(): void {
    for (const [name, value] of Object.entries(process.env)) {
      if (value !== undefined && AccountManager.ENV_OVERRIDE_PATTERN.test(name)) {
        this.capturedEnvOverrides.set(this.hashCacheKey(name), this.encrypt(value));
        delete process.env[name];
      }
    }
  }

  /**
   * Return a captured override value by variable name, decrypting it from the
   * cache. Returns `undefined` when no such variable was present at startup.
   */
  private getEnvOverride(name: string): string | undefined {
    const encrypted = this.capturedEnvOverrides.get(this.hashCacheKey(name));
    if (encrypted === undefined) {
      return undefined;
    }
    return this.decrypt(encrypted);
  }

  /**
   * Derive a deterministic, non-reversible cache key from a variable name via
   * HMAC-SHA256 keyed by the encryption key. Keeps the account name (embedded in
   * the variable name) out of the in-memory cache in plaintext while still
   * allowing lookups.
   */
  private hashCacheKey(name: string): string {
    return crypto
      .createHmac('sha256', Buffer.from(this.encryptionKey, 'hex'))
      .update(name)
      .digest('hex');
  }

  getAllAccounts(): ImapAccount[] {
    return Array.from(this.readAccounts().keys()).map(id => this.getAccount(id)!);
  }

  /**
   * Resolve which account a tool call refers to, in a backward-compatible way:
   *   1. explicit `accountId`        → must exist
   *   2. explicit `accountName`      → matched by name
   *   3. neither, and exactly ONE account configured → that account (default)
   * Throws a helpful, actionable error otherwise. Returns the account id.
   */
  resolveAccountId(accountId?: string, accountName?: string): string {
    this.loadAccountsSync();

    if (accountId) {
      if (!this.accounts.has(accountId)) {
        throw new Error(`Account ${accountId} not found. Use imap_list_accounts to see available accounts.`);
      }
      return accountId;
    }

    if (accountName) {
      const match = Array.from(this.accounts.values()).find(acc => acc.name === accountName);
      if (!match) {
        throw new Error(`No account named "${accountName}". Use imap_list_accounts to see available accounts.`);
      }
      return match.id;
    }

    const all = Array.from(this.accounts.values());
    if (all.length === 1) {
      return all[0].id;
    }
    if (all.length === 0) {
      throw new Error('No accounts configured. Add one with imap_add_account (or run the setup wizard).');
    }
    throw new Error(
      `Multiple accounts are configured (${all.length}). Specify accountId or accountName. Use imap_list_accounts to see them.`
    );
  }

  getAccountByName(name: string): ImapAccount | undefined {
    const account = Array.from(this.readAccounts().values()).find(account => account.name === name);
    return account ? this.getAccount(account.id) : undefined;
  }

  private readAccounts(): Map<string, StoredAccount> {
    try {
      const accounts = JSON.parse(readFileSync(this.configPath, 'utf-8'));
      if (!Array.isArray(accounts) || accounts.some(account =>
        !account || typeof account.id !== 'string' || typeof account.name !== 'string')) {
        throw new Error('Invalid account store');
      }
      const result = new Map<string, StoredAccount>(accounts.map(account => [account.id, account]));
      if (result.size !== accounts.length) throw new Error('Duplicate account ids');
      return result;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return new Map();
      // JSON parser errors can include the input (and thus account secrets).
      throw new Error('Cannot read account store; restore a valid accounts.json before continuing.');
    }
  }

  private loadAccountsSync(): void {
    this.accounts = this.readAccounts();
  }

  private async transaction<T>(change: (accounts: Map<string, StoredAccount>, createdRefs: string[]) => T): Promise<T> {
    const dir = path.dirname(this.configPath);
    await fs.mkdir(dir, { recursive: true, mode: 0o700 });
    const lockPath = this.configPath + '.lock';
    const deadline = Date.now() + 5000;
    // mkdir is exclusive across processes. Never steal a lock based on age:
    // a paused writer could resume and overwrite a newer transaction.
    for (;;) {
      try {
        await fs.mkdir(lockPath, { mode: 0o700 });
        break;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
        if (Date.now() >= deadline) {
          throw new Error('Account store is locked. Retry; after a crash, stop all server/wizard instances before removing accounts.json.lock.');
        }
        await new Promise(resolve => setTimeout(resolve, 25));
      }
    }
    const createdRefs: string[] = [];
    let committed = false;
    try {
      const previous = this.readAccounts();
      const accounts = new Map(previous);
      const result = change(accounts, createdRefs);
      await this.saveAccounts(accounts);
      committed = true;
      this.accounts = accounts;
      const active = new Set(Array.from(accounts.values()).map(account => account.credentialRef));
      for (const account of previous.values()) {
        if (account.credentialRef && !active.has(account.credentialRef)) this.retireCredential(account.credentialRef);
      }
      if (Array.from(accounts.values()).every(account => account.credentialRef)) {
        // Only after a successful atomic config replacement. Native entries
        // were read back before that replacement, so legacy copies are retired last.
        await fs.unlink(path.join(path.dirname(this.configPath), '.key')).catch(error => {
          if (error.code !== 'ENOENT') console.error('Could not remove the retired legacy key file.');
        });
      }
      return result;
    } finally {
      if (!committed) for (const reference of createdRefs) this.retireCredential(reference);
      await fs.rmdir(lockPath);
    }
  }

  private retireCredential(reference: string): void {
    try { this.credentialStore.delete(reference); }
    catch { console.error(`Could not remove retired keychain entry ${reference}; it is no longer needed by this operation.`); }
  }

  private async saveAccounts(accounts: Map<string, StoredAccount>): Promise<void> {
    const temporary = this.configPath + '.' + crypto.randomUUID() + '.tmp';
    try {
      const file = await fs.open(temporary, 'wx', 0o600);
      try {
        await file.writeFile(JSON.stringify(Array.from(accounts.values()), null, 2));
        await file.sync();
      } finally {
        await file.close();
      }
      await fs.rename(temporary, this.configPath);
      await this.enforceStorePermissions();
    } finally {
      await fs.unlink(temporary).catch(error => {
        if (error.code !== 'ENOENT') throw error;
      });
    }
  }

  /**
   * Defence in depth for metadata and any remaining legacy key. The `mode` options above only
   * apply when a file is *created*; a store written before this hardening — or
   * under a permissive umask — could still be world-readable. Re-assert
   * owner-only permissions on the directory, the accounts file, and the key.
   * Best effort: silently ignored on platforms without POSIX modes (Windows)
   * or when a path does not exist yet.
   */
  private async enforceStorePermissions(): Promise<void> {
    if (process.platform === 'win32') return;

    const dir = path.dirname(this.configPath);
    const keyPath = path.join(dir, '.key');
    const targets: Array<[string, number]> = [
      [dir, 0o700],
      [this.configPath, 0o600],
      [keyPath, 0o600],
    ];

    for (const [target, mode] of targets) {
      try {
        await fs.chmod(target, mode);
      } catch {
        // best effort — path may not exist yet, or fs is stubbed in tests
      }
    }
  }

  private encrypt(text: string): string {
    const iv = crypto.randomBytes(16);
    const cipher = crypto.createCipheriv(
      'aes-256-cbc',
      Buffer.from(this.encryptionKey, 'hex'),
      iv
    );

    let encrypted = cipher.update(text, 'utf8', 'hex');
    encrypted += cipher.final('hex');

    return iv.toString('hex') + ':' + encrypted;
  }

  private decryptLegacyField(value: string | null | undefined): string {
    if (value === undefined || value === null || value === '') return '';
    if (typeof value !== 'string' || !value.includes(':')) {
      throw new Error('Cannot decrypt credential field: value is not a valid encrypted string');
    }
    try {
      const key = readFileSync(path.join(path.dirname(this.configPath), '.key'), 'utf-8');
      if (!/^[a-f0-9]{64}$/i.test(key)) throw new Error();
      const [iv, encrypted] = value.split(':');
      const decipher = crypto.createDecipheriv('aes-256-cbc', Buffer.from(key, 'hex'), Buffer.from(iv, 'hex'));
      return decipher.update(encrypted, 'hex', 'utf8') + decipher.final('utf8');
    } catch {
      throw new Error('Cannot read legacy passwords. Restore the original .key file or remove and recreate this account in the setup wizard.');
    }
  }

  private decrypt(text: string): string {
    const [ivHex, encrypted] = text.split(':');
    const iv = Buffer.from(ivHex, 'hex');
    const decipher = crypto.createDecipheriv(
      'aes-256-cbc',
      Buffer.from(this.encryptionKey, 'hex'),
      iv
    );

    let decrypted = decipher.update(encrypted, 'hex', 'utf8');
    decrypted += decipher.final('utf8');

    return decrypted;
  }
}