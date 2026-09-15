import { z } from 'zod';

/**
 * Shared "which account?" input shape.
 *
 * `accountId` is accepted exactly as it always was; `accountName` and the
 * single-configured-account default are additive conveniences, resolved by
 * `AccountManager.resolveAccountId`. Every account-scoped tool spreads this so
 * the argument names an LLM learns on one tool keep working on the next.
 *
 * The `.describe()` text is part of the published schema — keep it stable.
 */
export const accountSelector = {
  accountId: z.string().optional().describe('Account ID (from imap_list_accounts). Optional if accountName is given or only one account is configured.'),
  accountName: z.string().optional().describe('Account name instead of accountId. Optional if accountId is given or only one account is configured.'),
};
