import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { AccountManager } from '../services/account-manager.js';
import { ImapService } from '../services/imap-service.js';
import { SmtpService } from '../services/smtp-service.js';
import { z } from 'zod';
import { accountSelector } from './account-selector.js';
import { getProviderById, getProviders } from '../providers/catalogue.js';

export function accountTools(
  server: McpServer,
  accountManager: AccountManager,
  imapService: ImapService,
  smtpService: SmtpService
): void {
  // Add account tool
  server.registerTool('imap_add_account', {
    description: 'Add an IMAP account and save its passwords in the system keychain. Requires an available, unlocked OS credential store; never falls back to local password files',
    inputSchema: {
      name: z.string().describe('Friendly name for the account'),
      host: z.string().describe('IMAP server hostname'),
      port: z.coerce.number().default(993).describe('IMAP server port (default: 993)'),
      user: z.string().describe('Username for authentication'),
      password: z.string().describe('Password for authentication'),
      tls: z.boolean().default(true).describe('Use TLS/SSL (default: true)'),
      email: z.string().optional().describe('Email address (From: header). Defaults to user if omitted'),
      smtpHost: z.string().optional().describe('SMTP server hostname. Defaults to IMAP host with imap.→smtp. rewrite'),
      smtpPort: z.coerce.number().optional().describe('SMTP server port (465 for SMTPS, 587 for STARTTLS). Defaults to 587'),
      smtpSecure: z.boolean().optional().describe('Use implicit TLS (SMTPS). Ignored for port 587/25 which always use STARTTLS, and for port 465 which always uses implicit TLS'),
      sentFolder: z.string().optional().describe('Explicit Sent-folder name for saving sent-mail copies (e.g. "Gesendet"). Only needed when auto-detection fails — the server must lack a \\Sent SPECIAL-USE folder. Check names with imap_list_folders'),
      defaultBcc: z.union([z.string(), z.array(z.string())]).optional().describe('Optional BCC address(es) applied automatically to every outbound send, reply, forward, and draft for this account. Merged with any per-call bcc'),
      tlsCa: z.string().optional().describe('Extra CA certificate to trust for this account\'s IMAP TLS: a path to a PEM file (a leading ~ is expanded) or the PEM text itself. Needed for a local bridge serving a self-signed certificate, e.g. Proton Mail Bridge on 127.0.0.1:1143. Scoped to this account only'),
      provider: z.string().optional().describe('Catalogue provider id this account is based on, e.g. "gmail", "protonmail" (see imap_list_accounts output or the setup wizard). Fills in any host/port/security left unspecified, and is recorded on the account so nothing has to be guessed from the email domain later'),
    }
  }, async ({ name, host, port, user, password, tls, email, smtpHost, smtpPort, smtpSecure, sentFolder, defaultBcc, tlsCa, provider }) => {
    // A provider is a template: its values fill the gaps at write time and the
    // complete result is stored. Nothing is resolved from the catalogue when
    // connecting, so a later catalogue change cannot alter this account.
    const picked = getProviderById(provider);
    if (provider && !picked) {
      throw new Error(`Unknown provider "${provider}". Known ids: ${getProviders().map(p => p.id).join(', ')}`);
    }
    const resolvedHost = host || picked?.imap?.host;
    if (!resolvedHost) {
      throw new Error('Either host or a provider with IMAP settings is required.');
    }
    const resolvedPort = host ? port : (picked?.imap?.port ?? port);
    const resolvedTls = host ? tls : (picked?.imap ? picked.imap.security !== 'starttls' : tls);
    const smtp = (smtpHost || smtpPort !== undefined || smtpSecure !== undefined)
      ? {
          host: smtpHost || resolvedHost,
          port: smtpPort ?? 587,
          secure: smtpSecure ?? false,
        }
      : picked?.smtp
        ? {
            host: picked.smtp.host,
            port: picked.smtp.port,
            secure: picked.smtp.security === 'implicit',
          }
        : undefined;

    const account = await accountManager.addAccount({
      name,
      host: resolvedHost,
      port: resolvedPort,
      user,
      password,
      tls: resolvedTls,
      ...(picked ? { provider: picked.id } : {}),
      ...(email ? { email } : {}),
      ...(smtp ? { smtp } : {}),
      ...(sentFolder ? { sentFolder } : {}),
      ...(defaultBcc !== undefined && defaultBcc !== '' && !(Array.isArray(defaultBcc) && defaultBcc.length === 0)
        ? { defaultBcc }
        : {}),
      ...(tlsCa ? { tlsCa } : {}),
    });

    return {
      content: [{
        type: 'text',
        text: JSON.stringify({
          success: true,
          accountId: account.id,
          message: `Account "${name}" added successfully`,
        }, null, 2)
      }]
    };
  });

  // Update account tool — lets callers fix SMTP config (and other fields) on existing accounts
  server.registerTool('imap_update_account', {
    description: 'Update an existing IMAP account. Useful for fixing SMTP settings without removing and re-adding the account. Omitted SMTP credentials are preserved; passwords are saved and verified in the system keychain. Editing a legacy account migrates its credentials.',
    inputSchema: {
      accountId: z.string().describe('ID of the account to update'),
      name: z.string().optional().describe('New friendly name'),
      host: z.string().optional().describe('IMAP host'),
      port: z.coerce.number().optional().describe('IMAP port'),
      user: z.string().optional().describe('IMAP username'),
      password: z.string().optional().describe('New password'),
      tls: z.boolean().optional().describe('Use TLS for IMAP'),
      email: z.string().optional().describe('Email address (From: header)'),
      smtpHost: z.string().optional().describe('SMTP hostname'),
      smtpPort: z.coerce.number().optional().describe('SMTP port (465 for SMTPS, 587 for STARTTLS)'),
      smtpSecure: z.boolean().optional().describe('Use implicit TLS (SMTPS). Port 587/25 always use STARTTLS regardless'),
      smtpUser: z.string().optional().describe('SMTP username (if different from IMAP user)'),
      smtpPassword: z.string().optional().describe('SMTP password (if different from IMAP password)'),
      saveToSent: z.boolean().optional().describe('Save sent emails to the Sent folder'),
      sentFolder: z.string().optional().describe('Explicit Sent-folder name for saving sent-mail copies (e.g. "Gesendet"). Overrides auto-detection; pass an empty string to clear the override and re-enable auto-detection. Check names with imap_list_folders'),
      defaultBcc: z.union([z.string(), z.array(z.string())]).optional().describe('Optional BCC address(es) applied automatically to every outbound message for this account. Pass an empty string to clear'),
      tlsCa: z.string().optional().describe('Extra CA certificate to trust for this account\'s IMAP TLS: a path to a PEM file (a leading ~ is expanded) or the PEM text itself. Pass an empty string to clear and go back to the system trust store'),
    }
  }, async ({ accountId, name, host, port, user, password, tls, email, smtpHost, smtpPort, smtpSecure, smtpUser, smtpPassword, saveToSent, sentFolder, defaultBcc, tlsCa }) => {
    const updates: any = {};
    if (name !== undefined) updates.name = name;
    if (host !== undefined) updates.host = host;
    if (port !== undefined) updates.port = port;
    if (user !== undefined) updates.user = user;
    if (password !== undefined) updates.password = password;
    if (tls !== undefined) updates.tls = tls;
    if (email !== undefined) updates.email = email;
    if (saveToSent !== undefined) updates.saveToSent = saveToSent;
    // Empty string clears the override (falls back to auto-detection).
    if (sentFolder !== undefined) updates.sentFolder = sentFolder === '' ? undefined : sentFolder;
    // Empty string (or empty array) clears the default BCC.
    if (defaultBcc !== undefined) {
      if (defaultBcc === '' || (Array.isArray(defaultBcc) && defaultBcc.length === 0)) {
        updates.defaultBcc = undefined;
      } else {
        updates.defaultBcc = defaultBcc;
      }
    }

    // Empty string clears the CA and restores the default trust store.
    if (tlsCa !== undefined) updates.tlsCa = tlsCa === '' ? undefined : tlsCa;

    const smtpTouched = [smtpHost, smtpPort, smtpSecure, smtpUser, smtpPassword].some(v => v !== undefined);
    if (smtpTouched) {
      updates.smtp = {
        ...(smtpHost !== undefined ? { host: smtpHost } : {}),
        ...(smtpPort !== undefined ? { port: smtpPort } : {}),
        ...(smtpSecure !== undefined ? { secure: smtpSecure } : {}),
        ...(smtpUser !== undefined ? { user: smtpUser } : {}),
        ...(smtpPassword !== undefined ? { password: smtpPassword } : {}),
      };
    }

    const updated = await accountManager.updateAccount(accountId, updates);
    // Both protocols can inherit the IMAP credentials. Reconnect after a
    // successful update so cached sessions cannot retain old credentials.
    smtpService.disconnect(accountId);
    await imapService.disconnect(accountId);

    return {
      content: [{
        type: 'text',
        text: JSON.stringify({
          success: true,
          accountId: updated.id,
          message: `Account "${updated.name}" updated`,
          smtp: updated.smtp ? { host: updated.smtp.host, port: updated.smtp.port, secure: updated.smtp.secure } : undefined,
        }, null, 2)
      }]
    };
  });

  // List accounts tool
  server.registerTool('imap_list_accounts', {
    description: 'List configured IMAP accounts without unlocking or reading passwords from the system keychain',
    inputSchema: {}
  }, async () => {
    const accounts = accountManager.listAccountMetadata();
    
    return {
      content: [{
        type: 'text',
        text: JSON.stringify({
          accounts: accounts.map(acc => ({
            id: acc.id,
            name: acc.name,
            host: acc.host,
            port: acc.port,
            user: acc.user,
            tls: acc.tls,
            ...(acc.provider ? { provider: acc.provider } : {}),
          })),
        }, null, 2)
      }]
    };
  });

  // Remove account tool
  server.registerTool('imap_remove_account', {
    description: 'Remove an IMAP account configuration',
    inputSchema: {
      accountId: z.string().describe('ID of the account to remove'),
    }
  }, async ({ accountId }) => {
    await imapService.disconnect(accountId);
    await accountManager.removeAccount(accountId);
    
    return {
      content: [{
        type: 'text',
        text: JSON.stringify({
          success: true,
          message: `Account ${accountId} removed successfully`,
        }, null, 2)
      }]
    };
  });

  // Connect to account tool
  server.registerTool('imap_connect', {
    description: 'Connect to an IMAP account',
    inputSchema: {
      accountId: z.string().optional().describe('Account ID to connect to'),
      accountName: z.string().optional().describe('Account name to connect to'),
    }
  }, async ({ accountId, accountName }) => {
    let account;
    
    if (accountId) {
      account = accountManager.getAccount(accountId);
    } else if (accountName) {
      account = accountManager.getAccountByName(accountName);
    } else {
      throw new Error('Either accountId or accountName must be provided');
    }
    
    if (!account) {
      throw new Error('Account not found');
    }
    
    await imapService.connect(account);
    
    return {
      content: [{
        type: 'text',
        text: JSON.stringify({
          success: true,
          message: `Connected to account "${account.name}"`,
          accountId: account.id,
        }, null, 2)
      }]
    };
  });

  // Disconnect from account tool
  server.registerTool('imap_disconnect', {
    description: 'Disconnect from an IMAP account',
    inputSchema: {
      accountId: z.string().describe('Account ID to disconnect from'),
    }
  }, async ({ accountId }) => {
    await imapService.disconnect(accountId);

    return {
      content: [{
        type: 'text',
        text: JSON.stringify({
          success: true,
          message: `Disconnected from account ${accountId}`,
        }, null, 2)
      }]
    };
  });

  // Test account connection tool (without re-entering password)
  server.registerTool('imap_test_account', {
    description: 'Test an existing account connection without re-entering credentials. Validates IMAP connectivity and returns folder count and message count.',
    inputSchema: {
      ...accountSelector,
    }
  }, async ({ accountId: rawAccountId, accountName }) => {
    const accountId = accountManager.resolveAccountId(rawAccountId, accountName);
    const account = accountManager.getAccount(accountId);
    if (!account) {
      throw new Error(`Account ${accountId} not found`);
    }

    const result = await imapService.testConnection(account);

    return {
      content: [{
        type: 'text',
        text: JSON.stringify({
          accountId,
          accountName: account.name,
          host: account.host,
          ...result,
        }, null, 2)
      }]
    };
  });
}