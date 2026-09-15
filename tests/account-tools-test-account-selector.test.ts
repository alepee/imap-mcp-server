import { describe, it, expect, vi, beforeEach } from 'vitest';
import { accountTools } from '../src/tools/account-tools.js';

// imap_test_account used to declare a bare `accountId`, unlike every other
// account-scoped tool. Calling it by name passed `undefined` to getAccount and
// failed with "Account undefined not found" — pointing at the wrong thing.

let handler: Function;
let schema: Record<string, any>;

const mockServer = {
  registerTool: vi.fn((name: string, def: any, fn: Function) => {
    if (name === 'imap_test_account') {
      handler = fn;
      schema = def.inputSchema;
    }
  }),
};

const account = { id: 'acc-1', name: 'Proton', host: '127.0.0.1', port: 1143, user: 'a@b.c', password: 'p', tls: false };

const mockAccountManager = {
  // Mirrors the real resolver: id wins, then name, then the single-account default.
  resolveAccountId: vi.fn((id?: string, name?: string) => {
    if (id) return id;
    if (name === 'Proton') return 'acc-1';
    if (name) throw new Error(`No account named "${name}".`);
    return 'acc-1';
  }),
  getAccount: vi.fn((id: string) => (id === 'acc-1' ? account : undefined)),
};

const mockImapService = {
  testConnection: vi.fn(async () => ({ success: true, folders: 16, messageCount: 215 })),
};

describe('imap_test_account — account selection', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    accountTools(mockServer as any, mockAccountManager as any, mockImapService as any, {} as any);
  });

  it('publishes the shared selector rather than a bare accountId', () => {
    expect(Object.keys(schema).sort()).toEqual(['accountId', 'accountName']);
  });

  it('resolves an account by name', async () => {
    const res = await handler({ accountName: 'Proton' });
    expect(JSON.parse(res.content[0].text)).toMatchObject({ accountId: 'acc-1', accountName: 'Proton', success: true });
  });

  it('still resolves an account by id', async () => {
    const res = await handler({ accountId: 'acc-1' });
    expect(JSON.parse(res.content[0].text)).toMatchObject({ accountId: 'acc-1', success: true });
  });

  it('falls back to the single configured account when neither is given', async () => {
    const res = await handler({});
    expect(JSON.parse(res.content[0].text)).toMatchObject({ accountId: 'acc-1', success: true });
  });

  it('surfaces the resolver error for an unknown name', async () => {
    await expect(handler({ accountName: 'Nope' })).rejects.toThrow(/No account named "Nope"/);
  });
});
