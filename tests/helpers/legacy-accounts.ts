import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import type { ImapAccount } from '../../src/types/index.js';

/** Synthetic encrypted fixture in an isolated test directory; no real credentials. */
export function writeLegacyAccounts(configPath: string, accounts: ImapAccount[]): void {
  const key = crypto.randomBytes(32);
  const encrypt = (value: string) => {
    const iv = crypto.randomBytes(16);
    const cipher = crypto.createCipheriv('aes-256-cbc', key, iv);
    return iv.toString('hex') + ':' + cipher.update(value, 'utf8', 'hex') + cipher.final('hex');
  };
  fs.mkdirSync(path.dirname(configPath), { recursive: true });
  fs.writeFileSync(path.join(path.dirname(configPath), '.key'), key.toString('hex'));
  fs.writeFileSync(configPath, JSON.stringify(accounts.map(account => ({
    ...account, password: encrypt(account.password),
    ...(account.smtp ? { smtp: { ...account.smtp,
      ...(account.smtp.password !== undefined ? { password: encrypt(account.smtp.password) } : {}),
    } } : {}),
  }))));
}
