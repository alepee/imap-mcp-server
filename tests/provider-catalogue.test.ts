import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import {
  getProviders,
  getProviderById,
  getProviderByEmail,
  mergeCatalogues,
  catalogueSchema,
} from '../src/providers/catalogue.js';

const entry = (over: Record<string, any> = {}) => ({
  id: 'x',
  displayName: 'X',
  domains: ['x.example'],
  imap: { host: 'imap.x.example', port: 993, security: 'implicit' as const },
  smtp: { host: 'smtp.x.example', port: 465, security: 'implicit' as const },
  ...over,
});

describe('provider catalogue — built-in', () => {
  it('loads and is non-empty', () => {
    expect(getProviders().length).toBeGreaterThan(10);
  });

  it('gives every non-manual provider both legs', () => {
    for (const p of getProviders()) {
      if (p.manual) continue;
      expect(p.imap, `${p.id} imap`).toBeDefined();
      expect(p.smtp, `${p.id} smtp`).toBeDefined();
    }
  });

  it('resolves by id and by domain', () => {
    expect(getProviderById('gmail')?.imap?.host).toBe('imap.gmail.com');
    expect(getProviderByEmail('someone@googlemail.com')?.id).toBe('gmail');
    expect(getProviderById(undefined)).toBeUndefined();
  });

  it('keeps Proton Bridge on STARTTLS', () => {
    // The regression behind #7: this entry must stay starttls, or every Bridge
    // account gets rewritten to implicit TLS and fails with "wrong version number".
    expect(getProviderById('protonmail')?.imap?.security).toBe('starttls');
    expect(getProviderById('protonmail')?.imap?.port).toBe(1143);
  });
});

describe('provider catalogue — single source of truth', () => {
  // The three tables this replaced disagreed for five providers. Nothing may
  // reintroduce a private one.
  const read = (p: string) => readFileSync(join(process.cwd(), p), 'utf-8');

  it('leaves no competing table in the services', () => {
    expect(read('src/services/smtp-service.ts')).not.toMatch(/commonProviders/);
    expect(read('src/services/imap-service.ts')).not.toMatch(/PROVIDERS_REQUIRING_IMAP_ENABLE/);
  });

  it('has no leftover email-providers module', () => {
    expect(() => read('src/providers/email-providers.ts')).toThrow();
  });
});

describe('provider catalogue — schema strictness', () => {
  // Whole-record replacement is only safe if the schema demands the essentials.
  // Otherwise a partial override silently yields a provider that cannot send.
  const parse = (providers: any[]) => catalogueSchema.safeParse({ version: 1, providers });

  it('rejects an entry missing smtp', () => {
    const r = parse([{ id: 'x', displayName: 'X', imap: { host: 'h', port: 1, security: 'implicit' } }]);
    expect(r.success).toBe(false);
  });

  it('rejects an entry missing imap', () => {
    expect(parse([{ id: 'x', displayName: 'X', smtp: { host: 's', port: 2, security: 'implicit' } }]).success).toBe(false);
  });

  it('allows a manual tile to carry no connection settings', () => {
    expect(parse([{ id: 'custom', displayName: 'Custom', manual: true }]).success).toBe(true);
  });

  it('allows a bare disabled entry', () => {
    expect(parse([{ id: 'aol', displayName: 'AOL', disabled: true }]).success).toBe(true);
  });

  it('rejects an unknown security value', () => {
    expect(parse([entry({ imap: { host: 'h', port: 1, security: 'SSL' } })]).success).toBe(false);
  });
});

describe('mergeCatalogues', () => {
  const builtIn = [entry({ id: 'gmail' }), entry({ id: 'aol' })] as any[];

  it('replaces a record whole rather than merging fields', () => {
    const merged = mergeCatalogues(builtIn, [
      { id: 'gmail', displayName: 'Mine', domains: [], imap: { host: 'h', port: 1, security: 'starttls' }, smtp: { host: 's', port: 2, security: 'starttls' } },
    ] as any[]);
    const gmail = merged.find(p => p.id === 'gmail')!;
    expect(gmail.displayName).toBe('Mine');
    expect(gmail.imap!.host).toBe('h');
    // Nothing inherited from the built-in entry: what the user wrote is what applies.
    expect(gmail.domains).toEqual([]);
  });

  it('appends an unknown id', () => {
    const merged = mergeCatalogues(builtIn, [entry({ id: 'acme' })] as any[]);
    expect(merged.map(p => p.id)).toContain('acme');
    expect(merged).toHaveLength(3);
  });

  it('hides a built-in entry with disabled', () => {
    const merged = mergeCatalogues(builtIn, [{ id: 'aol', disabled: true }] as any[]);
    expect(merged.map(p => p.id)).not.toContain('aol');
    expect(merged.map(p => p.id)).toContain('gmail');
  });

  it('leaves the built-in catalogue alone when the overlay is empty', () => {
    expect(mergeCatalogues(builtIn, [])).toHaveLength(2);
  });
});
