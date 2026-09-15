import { expect, it, vi } from 'vitest';
import { CREDENTIAL_SERVICE, SystemCredentialStore } from '../src/services/credential-store.js';
const reference = 'cc402730-a26e-4ee4-956d-29b84d914eb2';
it('uses the native API with persistent Secret Service and preserves password bytes', () => {
  let value: string | null = null;
  const factory = vi.fn(() => ({ getPassword: () => value, setPassword: (next: string) => { value = next; }, deleteCredential: () => { value = null; return true; } }));
  const store = new SystemCredentialStore(factory);
  expect(store.get(reference)).toBeNull();
  const secret = 'synthetic\n"$特殊';
  store.set(reference, secret);
  expect(store.get(reference)).toBe(secret);
  expect(factory).toHaveBeenCalledWith(CREDENTIAL_SERVICE, reference, { linux: { store: 'secret-service' } });
  store.delete(reference);
  expect(store.get(reference)).toBeNull();
});
it('sanitizes native failures without exposing their inputs', () => {
  const store = new SystemCredentialStore(() => { throw new Error('synthetic-secret'); });
  for (const action of [() => store.get(reference), () => store.set(reference, 'synthetic-secret'), () => store.delete(reference)]) {
    expect(action).toThrow('Unlock your system keychain');
    try { action(); } catch (error) { expect(String(error)).not.toContain('synthetic-secret'); }
  }
});
it('rejects arbitrary keychain references before accessing the native API', () => {
  const factory = vi.fn();
  expect(() => new SystemCredentialStore(factory).get('unrelated-item')).toThrow();
  expect(factory).not.toHaveBeenCalled();
});
