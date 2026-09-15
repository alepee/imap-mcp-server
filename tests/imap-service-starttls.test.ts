import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ImapService } from '../src/services/imap-service.js';
import type { ImapAccount } from '../src/types/index.js';

const constructorOptions: any[] = [];

vi.mock('imapflow', () => ({
  ImapFlow: class {
    constructor(options: any) {
      constructorOptions.push(options);
    }
    connect() { return Promise.resolve(); }
    logout() { return Promise.resolve(); }
    list() { return Promise.resolve([]); }
    status() { return Promise.resolve({ messages: 0 }); }
    on() {}
  },
}));

// imapflow's default (doSTARTTLS undefined with secure:false) attempts the
// upgrade and continues in cleartext when the server does not advertise it —
// documented in imap-flow.js as exposing a downgrade attack. Every STARTTLS
// account was therefore one stripped capability away from sending LOGIN in
// the clear.
describe('ImapService — STARTTLS is required, never opportunistic', () => {
  let service: ImapService;

  const account = (over: Partial<ImapAccount> = {}): ImapAccount => ({
    id: 'a1',
    name: 'Acct',
    host: 'mail.example.com',
    port: 143,
    user: 'user@example.com',
    password: 'secret',
    tls: false,
    ...over,
  });

  beforeEach(() => {
    constructorOptions.length = 0;
    service = new ImapService();
  });

  it('requires the upgrade on a STARTTLS account', async () => {
    await service.connect(account());
    expect(constructorOptions[0].secure).toBe(false);
    expect(constructorOptions[0].doSTARTTLS).toBe(true);
  });

  it('omits doSTARTTLS on an implicit-TLS account', async () => {
    // secure:true combined with doSTARTTLS:true is rejected by imapflow.
    await service.connect(account({ id: 'a2', port: 993, tls: true }));
    expect(constructorOptions[0].secure).toBe(true);
    expect('doSTARTTLS' in constructorOptions[0]).toBe(false);
  });

  it('applies the same rule to testConnection', async () => {
    await service.testConnection(account({ id: 'a3' }));
    expect(constructorOptions[0].doSTARTTLS).toBe(true);
  });

  it('never leaves an unencrypted-capable connection configured', async () => {
    for (const tls of [true, false]) {
      constructorOptions.length = 0;
      await service.connect(account({ id: `x${tls}`, tls }));
      const o = constructorOptions[0];
      // Either TLS from the first byte, or a mandatory upgrade. Never neither.
      expect(o.secure === true || o.doSTARTTLS === true).toBe(true);
    }
  });
});
