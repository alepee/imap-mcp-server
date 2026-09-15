import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest';
import { promises as fsp, writeFileSync, mkdirSync } from 'fs';
import os from 'os';
import path from 'path';
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
    on() {}
  },
}));

const TMP = path.join(os.tmpdir(), `imap-tls-ca-svc-${process.pid}`);
mkdirSync(TMP, { recursive: true });
const PEM = '-----BEGIN CERTIFICATE-----\nMIIBfake\n-----END CERTIFICATE-----\n';
const PEM_PATH = path.join(TMP, 'bridge.pem');
writeFileSync(PEM_PATH, PEM);

afterAll(async () => {
  await fsp.rm(TMP, { recursive: true, force: true });
});

describe('ImapService — per-account TLS CA', () => {
  let service: ImapService;

  const account = (over: Partial<ImapAccount> = {}): ImapAccount => ({
    id: 'bridge',
    name: 'Bridge',
    host: '127.0.0.1',
    port: 1143,
    user: 'user@example.com',
    password: 'secret',
    tls: false,
    ...over,
  });

  beforeEach(() => {
    constructorOptions.length = 0;
    service = new ImapService();
  });

  it('omits ca entirely when the account has none', async () => {
    await service.connect(account());
    expect(constructorOptions[0].tls).toEqual({ host: '127.0.0.1' });
    expect('ca' in constructorOptions[0].tls).toBe(false);
  });

  it('passes a CA read from a path, alongside the existing tls.host', async () => {
    await service.connect(account({ tlsCa: PEM_PATH }));
    expect(constructorOptions[0].tls.host).toBe('127.0.0.1');
    expect(constructorOptions[0].tls.ca).toBe(PEM);
  });

  it('passes inline PEM text', async () => {
    await service.connect(account({ id: 'inline', tlsCa: PEM }));
    expect(constructorOptions[0].tls.ca).toBe(PEM.trim());
  });

  it('never disables certificate verification', async () => {
    await service.connect(account({ tlsCa: PEM_PATH }));
    // The whole point of shipping `ca` rather than an escape hatch: trust is
    // extended, never switched off.
    expect(constructorOptions[0].tls.rejectUnauthorized).toBeUndefined();
  });

  it('fails before dialing when the CA path is unreadable', async () => {
    await expect(service.connect(account({ tlsCa: path.join(TMP, 'missing.pem') })))
      .rejects.toThrow(/Cannot read the TLS CA certificate/);
    expect(constructorOptions).toHaveLength(0);
  });
});
