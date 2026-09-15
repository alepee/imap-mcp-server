import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import { emailProviders } from '../src/providers/email-providers.js';

// public/js/app.js is a static asset and cannot be imported, so lift the
// function body out and run it — the same approach as env-credentials.test.ts.
const appJs = readFileSync(join(process.cwd(), 'public/js/app.js'), 'utf-8');

// Lifted lazily: a failed extraction must fail its own test, not abort the file
// before the inline-inference guard below gets a chance to run.
function loadResolveTlsSetting() {
  const match = appJs.match(/function resolveTlsSetting\(provider, pickedByUser, storedTls\) \{([\s\S]*?)\n\}/);
  if (!match) throw new Error('resolveTlsSetting() not found in public/js/app.js');
  return new Function('provider', 'pickedByUser', 'storedTls', match[1]) as
    (provider: any, pickedByUser: boolean, storedTls?: boolean) => boolean;
}

const resolveTlsSetting: (provider: any, pickedByUser: boolean, storedTls?: boolean) => boolean =
  (...args) => loadResolveTlsSetting()(...args);

const provider = (id: string) => emailProviders.find(p => p.id === id)!;

describe('wizard — TLS mode on save', () => {
  // The regression: editing a STARTTLS account selects no provider tile, the
  // wizard fell back to 'custom' (imapSecurity 'SSL'), and the save rewrote the
  // account to implicit TLS. Renaming a Proton Bridge account was enough to
  // break it, with "wrong version number" as the misleading symptom.
  it('keeps a stored STARTTLS account on edit when no provider was picked', () => {
    expect(resolveTlsSetting(provider('custom'), false, false)).toBe(false);
    expect(resolveTlsSetting(undefined, false, false)).toBe(false);
  });

  it('keeps a stored implicit-TLS account on edit too', () => {
    expect(resolveTlsSetting(provider('custom'), false, true)).toBe(true);
    expect(resolveTlsSetting(undefined, false, true)).toBe(true);
  });

  it('lets an explicit provider pick override the stored value', () => {
    // Proton Bridge is the STARTTLS provider in the catalogue.
    expect(resolveTlsSetting(provider('protonmail'), true, true)).toBe(false);
    expect(resolveTlsSetting(provider('gmail'), true, false)).toBe(true);
  });

  it('infers from the provider when adding an account (nothing stored)', () => {
    expect(resolveTlsSetting(provider('protonmail'), true, undefined)).toBe(false);
    expect(resolveTlsSetting(provider('gmail'), true, undefined)).toBe(true);
    expect(resolveTlsSetting(provider('custom'), false, undefined)).toBe(true);
  });

  // The check above only proves the new helper is correct. This one fails on
  // the original code: it is the inference, inlined into the save payloads,
  // that silently rewrote the account.
  it('never infers the TLS mode inline in a save payload', () => {
    const inlined = appJs.match(/tls:\s*selectedProvider\?\.imapSecurity/g) ?? [];
    expect(inlined, 'save payloads must go through resolveTlsSetting').toEqual([]);
  });

  it('agrees with the provider catalogue for every entry', () => {
    for (const p of emailProviders) {
      expect(resolveTlsSetting(p, true, undefined)).toBe(p.imapSecurity !== 'STARTTLS');
    }
  });
});
