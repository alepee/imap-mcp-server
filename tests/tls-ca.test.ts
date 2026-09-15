import { describe, it, expect, afterAll } from 'vitest';
import { promises as fsp, writeFileSync, mkdirSync } from 'fs';
import os from 'os';
import path from 'path';
import { resolveTlsCa } from '../src/utils/tls-ca.js';

const TMP = path.join(os.tmpdir(), `imap-tls-ca-${process.pid}`);
mkdirSync(TMP, { recursive: true });

const PEM = '-----BEGIN CERTIFICATE-----\nMIIBfake\n-----END CERTIFICATE-----\n';
const PEM_PATH = path.join(TMP, 'bridge.pem');
writeFileSync(PEM_PATH, PEM);

afterAll(async () => {
  await fsp.rm(TMP, { recursive: true, force: true });
});

describe('resolveTlsCa', () => {
  it('returns undefined when no CA is configured', () => {
    expect(resolveTlsCa(undefined)).toBeUndefined();
    expect(resolveTlsCa('')).toBeUndefined();
    expect(resolveTlsCa('   ')).toBeUndefined();
  });

  it('passes inline PEM text through untouched', () => {
    expect(resolveTlsCa(PEM)).toBe(PEM.trim());
  });

  it('reads a PEM file from a path', () => {
    expect(resolveTlsCa(PEM_PATH)).toBe(PEM);
  });

  it('expands a leading ~ to the home directory', () => {
    const rel = path.relative(os.homedir(), PEM_PATH);
    // Only meaningful when the temp dir sits under $HOME; skip otherwise.
    if (rel.startsWith('..')) return;
    expect(resolveTlsCa(path.join('~', rel))).toBe(PEM);
  });

  it('names the file when it cannot be read, instead of dropping the CA', () => {
    // A silently ignored CA resurfaces as an opaque self-signed-certificate
    // error at handshake time — the exact confusion this option removes.
    expect(() => resolveTlsCa(path.join(TMP, 'missing.pem')))
      .toThrow(/Cannot read the TLS CA certificate at .*missing\.pem/);
  });
});
