import { expect, it, vi } from 'vitest';
import { emailTools } from '../src/tools/email-tools.js';
import { ImapService } from '../src/services/imap-service.js';

it.each([0, -1, 0.5, 1001, Infinity, NaN])('rejects invalid chunkSize %s before connecting or deleting', async chunkSize => {
  const schemas = new Map<string, any>();
  emailTools({ registerTool: (name: string, config: any) => schemas.set(name, config.inputSchema) } as any,
    {} as any, {} as any, {} as any);
  for (const name of ['imap_bulk_delete', 'imap_bulk_delete_by_search']) {
    expect(schemas.get(name).chunkSize.safeParse(chunkSize).success).toBe(false);
  }
  const service = new ImapService();
  const connect = vi.spyOn(service as any, 'ensureConnected');
  await expect(service.bulkDelete('a', 'INBOX', [1], chunkSize)).rejects.toThrow(/chunkSize/);
  expect(connect).not.toHaveBeenCalled();
});
