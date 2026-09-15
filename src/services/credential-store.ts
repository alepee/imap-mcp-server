import { createRequire } from 'module';
import type { Entry, EntryOptions } from '@napi-rs/keyring';

/** Synchronous API matches account reads; implementations must never log secrets. */
export interface CredentialStore {
  get(reference: string): string | null;
  set(reference: string, secret: string): void;
  delete(reference: string): void;
}

export const CREDENTIAL_SERVICE = 'io.github.nikolausm.imap-mcp-server';
const require = createRequire(import.meta.url);
type NativeEntry = Pick<Entry, 'getPassword' | 'setPassword' | 'deleteCredential'>;
type EntryFactory = (service: string, reference: string, options: EntryOptions) => NativeEntry;

export function systemKeychainName(platform = process.platform): string {
  if (platform === 'darwin') return 'macOS Keychain';
  if (platform === 'win32') return 'Windows Credential Manager';
  if (platform === 'linux') return 'Secret Service';
  return 'system keychain';
}

/** No subprocesses, command-line passwords, environment transport or file fallback. */
export class SystemCredentialStore implements CredentialStore {
  constructor(private readonly factory: EntryFactory = (service, reference, options) => {
    // Load only when credentials are needed: listing accounts must work even
    // without an unlocked keychain or a usable native addon.
    const { Entry } = require('@napi-rs/keyring') as typeof import('@napi-rs/keyring');
    return new Entry(service, reference, options);
  }) {}

  private entry(reference: string): NativeEntry {
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(reference)) {
      throw new Error('Invalid system keychain reference.');
    }
    return this.factory(CREDENTIAL_SERVICE, reference, { linux: { store: 'secret-service' } });
  }

  private run<T>(operation: () => T): T {
    try {
      return operation();
    } catch {
      // Native errors may contain input values. Do not forward their message,
      // stack, cause, or stderr to a client or diagnostic log.
      throw new Error(`Cannot access ${systemKeychainName()}. Unlock your system keychain and allow access, then retry. On Linux, an unlocked Secret Service and a D-Bus session are required. No passwords were saved to a file.`);
    }
  }

  get(reference: string): string | null {
    return this.run(() => this.entry(reference).getPassword());
  }
  set(reference: string, secret: string): void {
    this.run(() => this.entry(reference).setPassword(secret));
  }
  delete(reference: string): void {
    this.run(() => { this.entry(reference).deleteCredential(); });
  }
}
