# Architecture

## Overview

```
src/
  index.ts                  MCP server over stdio; stdout carries JSON-RPC only
  setup.ts                  imap-setup: starts the wizard, registers Claude Desktop
  tools/
    index.ts                registration, read-only ceiling and allowlist
    account-selector.ts     accountId / accountName / single-account default
    account-tools.ts        add, update, remove, list, connect, test
    email-tools.ts          search, read, send, reply, forward, drafts, flags, moves, deletes, attachments
    folder-tools.ts         list, status, create, unread counts
    spam-tools.ts           analysis, domain stats, domain lists, spam deletes
  services/
    imap-service.ts         imapflow client per account, search fallback, Sent/Drafts append
    smtp-service.ts         nodemailer transport per account, MIME composition
    account-manager.ts      accounts.json store, transactions, legacy migration
    credential-store.ts     native keychain (@napi-rs/keyring), in-memory store for tests
    spam-service.ts         domain lists and header heuristics
    html-to-markdown.ts     Turndown rendering of HTML bodies
  providers/
    providers.json          built-in provider catalogue
    catalogue.ts            loading, user overrides from ~/.imap-mcp/providers.json
  utils/
    untrusted-content.ts    result envelope and output budget
    attachment-files.ts     confinement to IMAP_DOWNLOAD_DIR
    client-side-search.ts   criteria matching for servers with a broken SEARCH
    reply-headers.ts        reply-all recipients, References chain
    send-as.ts              from validation against allowedFrom
    tls-ca.ts               per-account CA resolution
    …
  web/server.ts             setup wizard API (Express), served with public/
```

## Request path

A tool call goes through the MCP SDK to a handler in `src/tools`. The handler resolves the account (`account-selector.ts`), calls a service, and returns JSON. Every result then passes through `untrusted-content.ts`, which adds the `security` envelope and applies the output budget before anything reaches the client. See [untrusted content](untrusted-content.md).

`tools/index.ts` decides which tools exist at all. Read-only mode is computed first, as a ceiling; the allowlist can only remove tools from it. A tool outside the result is never registered.

## IMAP connections

`ImapService` keeps one imapflow client per account. The first call on an account connects with the stored credentials. An imapflow client cannot reconnect once closed (an idle timeout between two calls closes it), so the service creates a new one, up to a bounded number of attempts before failing. Bulk deletes reconnect between chunks.

TLS is mandatory. `tls: true` connects with implicit TLS; `tls: false` sets imapflow's `doSTARTTLS`, which fails when the server does not offer the upgrade instead of continuing in cleartext. The certificate is checked against the host actually dialled, and an account's `tlsCa` is added to the trust store of that connection only.

When a SEARCH returns nothing on a folder that is not empty, the service runs `SEARCH ALL`. If that is empty too, the server's SEARCH is considered broken: envelopes are fetched and `client-side-search.ts` applies the criteria. Deleting tools check for this state and refuse to proceed.

## SMTP and sent copies

`SmtpService` builds the message with nodemailer's MailComposer. Bodies are normalized to CRLF, which strict IMAP servers require for APPEND. The Message-ID and date are fixed before composing, so the SMTP delivery, the Sent copy and the returned `messageId` agree. The raw message is kept with its Bcc header (`keepBcc`) for drafts and Sent copies; SMTP delivery uses the envelope.

The Sent folder is the account's `sentFolder`, else the folder carrying `\Sent`, else the first known localized name. A failed copy never fails the send: the result reports `sentSaveError`.

## Account store

`accounts.json` holds settings, usernames and opaque keychain references. Every mutation is a transaction:

1. Take an exclusive lock, `~/.imap-mcp/accounts.json.lock`, waiting up to five seconds. A lock is never stolen because of its age.
2. Reload the current file. Invalid JSON blocks the write instead of being replaced.
3. Write each new or changed password under a new keychain reference, and read it back.
4. Write a temporary file, flush it, and rename it over `accounts.json`.
5. Retire the keychain entries no longer referenced.

A failure before the rename leaves the previous file and its entries intact, and removes the entries created by the failed attempt. Reading metadata (`imap_list_accounts`, the wizard's list) never touches the keychain. Legacy accounts, with passwords encrypted in the file, are read through the same store until migrated; see [accounts](accounts.md#migrating-from-encrypted-files).

## Setup wizard

`web/server.ts` binds `127.0.0.1` only and also rejects requests whose `Host` is not a loopback name, against DNS rebinding. It never sends a stored password to the browser. Provider tiles come from the same catalogue as the server.

## Dependencies

| Package | Use |
| --- | --- |
| `@modelcontextprotocol/sdk` | MCP server and stdio transport |
| `imapflow` | IMAP client |
| `nodemailer` | SMTP transport and MIME composition |
| `mailparser`, `turndown` | Message parsing, HTML to Markdown |
| `pdf-parse` | PDF text, on explicit request |
| `@napi-rs/keyring` | Native OS keychain |
| `express` | Setup wizard |
| `zod` | Tool input schemas |

`tests/node-engines.test.ts` fails when a runtime dependency requires a newer Node than the one declared in `package.json`.
