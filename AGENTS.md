# AGENTS.md

Cross-agent project guide for **imap-mcp-server**, a Model Context Protocol (MCP)
server that gives AI assistants (Claude, ChatGPT, Cursor, …) access to IMAP/SMTP
mailboxes. This file is the shared source of truth for any agent or contributor
working in this repository.

## Architecture

`docs/architecture.md` is the detailed map. In short:

- **Entry point**: `src/index.ts` boots an `McpServer` (MCP SDK) over **stdio**
  and registers tools through `src/tools/index.ts`, which applies the read-only
  ceiling and the allowlist.
- **Services** (`src/services/`):
  - `ImapService`: IMAP through **`imapflow`**, one pooled client per account,
    search (with the client-side fallback for broken SEARCH), fetch, move,
    delete, append to Sent/Drafts.
  - `SmtpService`: outbound mail through **`nodemailer`**; composes raw MIME and sends.
  - `AccountManager`: account CRUD with native OS password storage via
    `SystemCredentialStore` (`@napi-rs/keyring`). Linux explicitly uses Secret
    Service, never the volatile fallback. `accounts.json` stores settings,
    usernames and opaque references. Metadata reads must not unlock the keychain.
    Mutations verify fresh keychain entries before atomic config commit; retire
    old entries afterward. Legacy AES files and startup env overrides are supported
    for migration only; native accounts ignore credential environment overrides.
    The wizard migrates all legacy accounts atomically and removes `.key` only
    after no legacy entries remain. Tests inject `MemoryCredentialStore`; never
    touch the developer's real keychain or credentials in automated tests.
  - `SpamService`: disposable/known-spam domains and header heuristics.
- **Providers** (`src/providers/`): `providers.json` is the single catalogue,
  merged with `~/.imap-mcp/providers.json`. Accounts record their provider id
  but never re-resolve settings from it.
- **Tools** (`src/tools/`), grouped by area:
  - `account-tools.ts`: add / update / list / remove / connect / disconnect / test.
  - `email-tools.ts`: search, get, latest, send, reply, forward, save draft,
    mark read/unread, flags, keywords, delete, bulk delete, move, attachments,
    upload, threads, Message-ID lookup.
  - `folder-tools.ts`: list, status, create, unread counts.
  - `spam-tools.ts`: spam analysis, domain stats, allow/deny lists.
- **Utils** (`src/utils/`): untrusted-content envelope and output budget,
  attachment path confinement, reply headers, send-as validation, TLS CA.
- **Web setup wizard**: `src/web/server.ts` (Express, loopback only) serves
  `public/` for account onboarding (`npm run setup` / `imap-setup`).
- **Types**: `src/types/index.ts`.
- All tools return **JSON-formatted text** content wrapped in the untrusted
  `security` envelope; errors are returned as structured JSON where practical
  rather than thrown for caller-facing failures.

## Documentation

`README.md` stays short: what it is, install, first account, client
configuration, features, limitations. Details live in `docs/`:

| File | Update it when you change |
| --- | --- |
| `docs/tools.md` | a tool, its parameters or its behaviour |
| `docs/accounts.md` | account fields, the wizard, keychain storage, the provider catalogue |
| `docs/configuration.md` | an environment variable, read-only mode, the allowlist |
| `docs/untrusted-content.md` | the result envelope, output budget, previews |
| `docs/troubleshooting.md` | a known error, a provider or server quirk |
| `docs/architecture.md` | services, connection handling, the account store |
| `CHANGELOG.md` | anything a user would notice |

Documentation is in English, plain and factual: say what the code does, name
its limits, no marketing adjectives, no emoji.

## Build / Test commands

```bash
npm install          # install dependencies
npm run build        # bundle to dist/ via esbuild (build.mjs)
npm test             # run the vitest suite (run mode)
npm run test:watch   # vitest in watch mode
npm run lint         # tsc --noEmit type-check
npm run dev          # run the server from source (tsx watch)
npm run setup        # launch the web setup wizard
```

Always run `npm run build` **and** `npm test` before committing changes that
touch `src/`. Keep the suite green.

> Note: `npm run lint` (`tsc --noEmit`) is memory-hungry on this project: the
> MCP SDK's `registerTool` generics are deep enough to surface a pre-existing
> `TS2589` and can OOM on low-RAM machines. Run it with a larger heap if needed
> (`node --max-old-space-size=8192 ./node_modules/typescript/bin/tsc --noEmit`).

## Security rules (must follow)

1. **Never log secrets.** Passwords, encryption keys, `accounts.json` contents,
   raw auth tokens, and full message bodies must not be written to stdout/stderr
   or to disk outside the user's mailbox/download directories. When adding logs,
   log identifiers (account id, folder, uid), not credentials.
2. **No destructive mail operations without explicit guard logic.** Deletes,
   bulk deletes, and moves must be driven by explicit caller input. Bulk/criteria
   deletion must keep its `dryRun` path and require concrete criteria; never
   delete a whole folder by default, and never widen a delete beyond what the
   caller specified.
3. **Tool schema changes require docs + tests.** Do not rename existing tools or
   change their input/output shape without (a) updating the tool `description`,
   (b) updating `docs/tools.md` (and `README.md` if a feature changes), and
   (c) adding/adjusting tests. Prefer additive,
   backward-compatible changes (new optional fields) over breaking ones.
4. **Credentials stay local.** Do not add telemetry, analytics, crash reporting,
   or any third-party network calls. The only outbound connections are to the
   user's own IMAP/SMTP servers.
5. **Validate and sanitize file paths** for attachment upload/download (already
   done via `path.basename`); keep writes confined to the configured directories.

## Conventions

- TypeScript, ESM (`"type": "module"`), **Node ≥ 22.12** (declared in
  `package.json` `engines.node`; CI runs 22.x and 24.x).
  - npm checks a dependency's `engines` against the Node doing the *install*,
    not against the floor we declare, so a dependency needing a newer Node
    installs silently and only breaks on a user's older runtime. This is how
    #108 happened. `tests/node-engines.test.ts` walks the runtime dependency
    tree and fails if any package needs more than we advertise. When it fires,
    either raise the floor (CI matrix, AGENTS.md and README with it) or pin the
    package back via npm `overrides`.
- Tool names are stable public API: `imap_*`. Do not rename without a strong
  reason and a migration note.
- Zod schemas describe every tool input; every field gets a `.describe()` that
  tells an LLM **when and how** to use it.
- Match the surrounding code style; keep error handling and connection cleanup
  consistent with existing tools.
