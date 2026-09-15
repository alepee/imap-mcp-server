import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import { getProviders } from '../src/providers/catalogue.js';

// The provider grid broke when the catalogue changed shape: renderProviders
// still read `provider.name`, which the new records do not carry. The template
// threw inside .map(), so innerHTML was never assigned and the whole grid came
// up empty — with nothing in the server logs, because the server was fine.
//
// Asserting on field names would only restate the bug. Run the real function
// against the real catalogue instead, with a DOM stub standing in for the grid.
const appJs = readFileSync(join(process.cwd(), 'public/js/app.js'), 'utf-8');

function renderWith(providers: unknown[]): string {
  const match = appJs.match(/function renderProviders\(\) \{([\s\S]*?)\n\}/);
  if (!match) throw new Error('renderProviders() not found in public/js/app.js');

  let html = '';
  const document = {
    getElementById: () => ({
      set innerHTML(v: string) { html = v; },
      get innerHTML() { return html; },
    }),
  };
  new Function('document', 'providers', match[1])(document, providers);
  return html;
}

describe('wizard — provider grid', () => {
  it('renders every provider from the real catalogue', () => {
    const providers = getProviders();
    const html = renderWith(providers);

    expect(providers.length).toBeGreaterThan(10);
    for (const p of providers) {
      expect(html, `${p.id} missing from the grid`).toContain(`selectProvider('${p.id}')`);
      expect(html, `${p.id} display name missing`).toContain(p.displayName);
    }
  });

  it('renders a manual tile that carries no domains or connection settings', () => {
    // The 'custom' entry has no imap/smtp and an empty domains list; the
    // template must not assume any of them.
    const html = renderWith([
      { id: 'custom', displayName: 'Custom/Other Provider', domains: [], manual: true, ui: {} },
    ]);
    expect(html).toContain("selectProvider('custom')");
    expect(html).toContain('Custom/Other Provider');
  });

  it('survives an entry with no ui block', () => {
    const html = renderWith([{ id: 'acme', displayName: 'ACME', domains: ['acme.example'] }]);
    expect(html).toContain("selectProvider('acme')");
    expect(html).toContain('acme.example');
  });

  it('produces no undefined in the markup', () => {
    // How the original failure would have read if the template had been lenient
    // instead of throwing.
    expect(renderWith(getProviders())).not.toContain('undefined');
  });
});
