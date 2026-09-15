import type { CredentialStore } from '../../src/services/credential-store.js';

/** Tests only. Never selected by production code or by an environment flag. */
export class MemoryCredentialStore implements CredentialStore {
  entries = new Map<string, string>();
  get(reference: string) { return this.entries.get(reference) ?? null; }
  set(reference: string, value: string) { this.entries.set(reference, value); }
  delete(reference: string) { this.entries.delete(reference); }
}
