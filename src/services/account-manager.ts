import { promises as fs } from 'fs';
import { readFileSync, writeFileSync, mkdirSync } from 'fs';
import path from 'path';
import os from 'os';
import crypto from 'crypto';
import { ImapAccount, SmtpConfig } from '../types/index.js';
import { ENV_CREDENTIAL_SUFFIXES, envVarName } from '../utils/env-credentials.js';

export type AccountUpdates = Partial<Omit<ImapAccount, 'id' | 'smtp'>> & { smtp?: Partial<SmtpConfig> };

export class AccountManager {
  private configPath: string;
  private accounts: Map<string, ImapAccount> = new Map();
  private encryptionKey: string;
  private capturedEnvOverrides: Map<string, string> = new Map();

  private static readonly ENV_OVERRIDE_PATTERN =
    /^IMAP_MCP_ACCOUNT_.+_(?:IMAP|SMTP)_(?:USERNAME|PASSWORD)$/;

  constructor() {
    this.configPath = path.join(os.homedir(), '.imap-mcp', 'accounts.json');
    this.encryptionKey = this.getOrCreateEncryptionKey();
    this.captureEnvOverrides();
    this.loadAccountsSync();
  }

  async addAccount(account: Omit<ImapAccount, 'id'>): Promise<ImapAccount> {
    const id = crypto.randomUUID();
    const stored = {
      ...account, id, password: this.encrypt(account.password),
      ...(account.smtp ? { smtp: {
        ...account.smtp,
        ...(account.smtp.password !== undefined ? { password: this.encrypt(account.smtp.password) } : {}),
      } } : {}),
    };
    await this.transaction(accounts => { accounts.set(id, stored); });
    return { ...account, id };
  }

  async removeAccount(id: string): Promise<void> {
    await this.transaction(accounts => {
      if (!accounts.delete(id)) throw new Error(`Account ${id} not found`);
    });
  }

  async updateAccount(id: string, updates: AccountUpdates): Promise<ImapAccount> {
    const updated = await this.transaction(accounts => {
      const existing = accounts.get(id);
      if (!existing) throw new Error(`Account with id ${id} not found`);
      // Merge against the stored record, never a getter result: getters may
      // contain environment overrides, which must never be persisted.
      const { smtp, ...fields } = updates;
      const next: ImapAccount = { ...existing, ...fields, id };
      if (fields.password !== undefined) next.password = this.encrypt(fields.password);
      if (smtp !== undefined) {
        next.smtp = {
          host: existing.host, port: 587, secure: false,
          ...existing.smtp, ...Object.fromEntries(Object.entries(smtp).filter(([, value]) => value !== undefined)),
        };
        if (smtp.password !== undefined) next.smtp.password = this.encrypt(smtp.password);
      }
      accounts.set(id, next);
      return next;
    });
    return {
      ...updated, password: this.decryptField(updated.password),
      ...(updated.smtp ? { smtp: { ...updated.smtp,
        ...(updated.smtp.password !== undefined ? { password: this.decryptField(updated.smtp.password) } : {}),
      } } : {}),
    };
  }

  getAccount(id: string): ImapAccount | undefined {
    this.loadAccountsSync();
    const account = this.accounts.get(id);
    if (!account) return undefined;

    const decrypted: ImapAccount = {
      ...account,
      password: this.decryptField(account.password),
    };

    if (account.smtp?.password) {
      decrypted.smtp = {
        ...account.smtp,
        password: this.decryptField(account.smtp.password),
      };
    }

    return this.applyEnvOverrides(decrypted);
  }

  /**
   * Override IMAP/SMTP credentials from environment variables, keyed by the
   * account's normalized name. This lets credentials be supplied at runtime
   * (e.g. from a secret manager) instead of the encrypted `accounts.json`.
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
    this.loadAccountsSync();
    return Array.from(this.accounts.values()).map(account => {
      const decrypted: ImapAccount = {
        ...account,
        password: this.decryptField(account.password),
      };

      if (account.smtp?.password) {
        decrypted.smtp = {
          ...account.smtp,
          password: this.decryptField(account.smtp.password),
        };
      }

      return this.applyEnvOverrides(decrypted);
    });
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
    this.loadAccountsSync();
    const account = Array.from(this.accounts.values()).find(acc => acc.name === name);
    if (!account) return undefined;

    const decrypted: ImapAccount = {
      ...account,
      password: this.decryptField(account.password),
    };

    if (account.smtp?.password) {
      decrypted.smtp = {
        ...account.smtp,
        password: this.decryptField(account.smtp.password),
      };
    }

    return this.applyEnvOverrides(decrypted);
  }

  private readAccounts(): Map<string, ImapAccount> {
    try {
      const accounts = JSON.parse(readFileSync(this.configPath, 'utf-8'));
      if (!Array.isArray(accounts) || accounts.some(account =>
        !account || typeof account.id !== 'string' || typeof account.name !== 'string')) {
        throw new Error('Invalid account store');
      }
      const result = new Map<string, ImapAccount>(accounts.map(account => [account.id, account]));
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

  private async transaction<T>(change: (accounts: Map<string, ImapAccount>) => T): Promise<T> {
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
    try {
      const accounts = this.readAccounts();
      const result = change(accounts);
      await this.saveAccounts(accounts);
      this.accounts = accounts;
      return result;
    } finally {
      await fs.rmdir(lockPath);
    }
  }

  private async saveAccounts(accounts: Map<string, ImapAccount>): Promise<void> {
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
   * Defence in depth for the credential store. `~/.imap-mcp/` holds the raw
   * AES-256 key and the (encrypted) accounts, so anyone able to read the key
   * plus the store can recover every password. The `mode` options above only
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

  private getOrCreateEncryptionKey(): string {
    const keyPath = path.join(os.homedir(), '.imap-mcp', '.key');
    
    try {
      const key = readFileSync(keyPath, 'utf-8');
      if (!/^[a-f0-9]{64}$/i.test(key)) throw new Error('Invalid encryption key; restore the original .key file.');
      return key;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      // Losing the key must not silently create a replacement for an existing store.
      try {
        readFileSync(this.configPath, 'utf-8');
      } catch (storeError) {
        if ((storeError as NodeJS.ErrnoException).code !== 'ENOENT') throw storeError;
        return this.createEncryptionKey(keyPath);
      }
      throw new Error('Encryption key is missing for the existing account store; restore the original .key file.');
    }
  }

  private createEncryptionKey(keyPath: string): string {
    const key = crypto.randomBytes(32).toString('hex');
    mkdirSync(path.dirname(keyPath), { recursive: true, mode: 0o700 });
    try {
      writeFileSync(keyPath, key, { mode: 0o600, flag: 'wx' });
      return key;
    } catch (writeError) {
      if ((writeError as NodeJS.ErrnoException).code !== 'EEXIST') throw writeError;
      // Another process won creation. Never replace its key.
      const existing = readFileSync(keyPath, 'utf-8');
      if (!/^[a-f0-9]{64}$/i.test(existing)) throw new Error('Encryption key creation in progress; retry startup.');
      return existing;
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

  /**
   * Decrypt a stored credential field.
   *
   * A missing or empty value (null, undefined, or "") is treated as "no
   * credential" and returns an empty string — the env-override mechanism can
   * still fill it at runtime. A non-empty value that is not a well-formed
   * encrypted string (missing the "iv:ciphertext" separator, or otherwise
   * undecryptable) is a corrupt entry and throws, rather than being silently
   * swallowed.
   */
  private decryptField(value: string | null | undefined): string {
    if (value === undefined || value === null || value === '') {
      return '';
    }
    if (typeof value !== 'string' || !value.includes(':')) {
      throw new Error('Cannot decrypt credential field: value is not a valid encrypted string');
    }
    return this.decrypt(value);
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