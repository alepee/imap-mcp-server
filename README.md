# IMAP MCP Server

[Changelog](CHANGELOG.md) · [Security](SECURITY.md) · [Notice](NOTICE.md) · [Upstream](https://github.com/nikolausm/imap-mcp-server)

A Model Context Protocol server that gives an AI assistant (Claude, Cursor, ChatGPT…) access to your IMAP and SMTP mailboxes: search, read, sort, reply, send. It runs locally over stdio, talks only to the mail servers you configure, and keeps passwords in the operating system keychain.

**Fork of [nikolausm/imap-mcp-server](https://github.com/nikolausm/imap-mcp-server) by Michael Nikolaus, not published to npm. Node.js 22.12 or later.** The `imap-mcp-server` package on npm is the upstream project: `npx imap-mcp-server` installs none of the changes made here. [NOTICE.md](NOTICE.md) lists what came from upstream and what changed.

## Install

```sh
git clone https://github.com/alepee/imap-mcp-server.git
cd imap-mcp-server
npm install
npm run build
```

`install.sh` (macOS, Linux) and `install.ps1` (Windows) do the same and also write an MCP client configuration. Read them before piping them into a shell:

```sh
curl -fsSL https://raw.githubusercontent.com/alepee/imap-mcp-server/main/install.sh | bash
```

## Add an account

```sh
npm run setup
```

The setup wizard opens in your browser on `http://localhost:3000`, offers presets for the common providers (Gmail, Outlook, Microsoft 365, iCloud, Yahoo, Fastmail, Proton Mail Bridge, GMX, WEB.DE, IONOS, mailbox.org, Posteo, Zoho, AOL) and writes the password to the keychain. It only listens on loopback. It can also register the server in Claude Desktop.

Accounts can also be added from the assistant with `imap_add_account`, but the password then goes through the model, the conversation transcript and the client logs. Use the wizard for any account you care about. See [accounts](docs/accounts.md).

## Connect your MCP client

Claude Code:

```sh
claude mcp add imap -- node /absolute/path/to/imap-mcp-server/dist/index.js
```

Claude Desktop (`~/Library/Application Support/Claude/claude_desktop_config.json` on macOS, `%APPDATA%\Claude\claude_desktop_config.json` on Windows):

```json
{
  "mcpServers": {
    "imap": {
      "command": "node",
      "args": ["/absolute/path/to/imap-mcp-server/dist/index.js"],
      "env": { "IMAP_MCP_READ_ONLY": "true" }
    }
  }
}
```

`IMAP_MCP_READ_ONLY` exposes only the tools that read mail. Remove it to let the assistant send, move and delete. Every variable is described in [configuration](docs/configuration.md).

Then ask in plain words: "what came in since this morning?", "find the invoice from Acme last month and save the PDF", "reply to Paul that Thursday works", "move this week's newsletters to Archive".

## Features

- **Multiple accounts**, selected by `accountId` or `accountName`, or implicitly when only one is configured. IMAP connections are pooled per account.
- **Search and read**: criteria search in one folder or across all folders, custom keywords, thread lookup through `In-Reply-To` / `References`, lookup by Message-ID. Bodies come back as Markdown by default; search results can carry the bodies too, to avoid one call per message.
- **Send, reply, forward, drafts** over SMTP. Reply-all keeps Cc and honours `Reply-To`, threading headers carry the full `References` chain, and the copy saved to Sent has the same Message-ID as the delivered message. Optional `defaultBcc` per account, and send-as aliases restricted to an `allowedFrom` list.
- **Sort**: mark read or unread, flag, custom keywords (provider colour labels), move with optional folder creation, delete one, many or by criteria. Criteria deletes need at least one concrete criterion and have a dry run.
- **Attachments**: downloaded into a dedicated folder without exposing their content to the model; PDF text and inline images on explicit request only. Large files can be uploaded once and attached by path.
- **Folders**: list with their RFC 6154 role (`\Sent`, `\Drafts`, `\Trash`…), status, creation, unread counts.
- **Spam triage**: sender-domain and raw-header analysis (bulk mailers, DMARC/SPF/DKIM failures), domain statistics, domain deletes with a dry run on by default.
- **Provider catalogue** in one JSON file, extensible from `~/.imap-mcp/providers.json` without forking. An account records the provider it came from and stores its full settings, so a catalogue change never alters a working account.
- **Local bridges**: a per-account CA certificate for Proton Mail Bridge and other self-signed endpoints, without trusting that certificate for the rest of the process.
- **Servers with a broken SEARCH** (Strato): an empty SEARCH on a non-empty folder is detected, and the server filters the fetched envelopes itself.

## Security

Mail is written by strangers, and anything in it can try to steer the model. The server labels every result as untrusted data, caps the text it returns, keeps attachment previews off by default, and never registers a write tool that read-only mode removed, even if an allowlist names it. These are mitigations, not guarantees: approvals for sending, deleting and changing accounts belong to the MCP host, outside the model. See [untrusted content](docs/untrusted-content.md) and [SECURITY.md](SECURITY.md).

- Passwords live in macOS Keychain, Windows Credential Manager or Linux Secret Service. There is no file fallback.
- IMAP connections require TLS: implicit TLS, or a STARTTLS upgrade that fails rather than continuing in cleartext.
- No telemetry, no analytics, no crash reporting. The only network connections are to your IMAP and SMTP servers.
- Attachment reads and writes are confined to `~/Downloads/imap-attachments` (or `IMAP_DOWNLOAD_DIR`). Existing files are never overwritten.

## Current limitations

Linux needs an unlocked Secret Service (GNOME Keyring or equivalent) on a D-Bus session the server can reach, headless machines included. Copying `accounts.json` to another machine does not move the passwords: back up the keychain as well. The keychain protects passwords at rest, not from a compromised server process.

Domains added with `imap_add_spam_domain` and `imap_add_whitelist_domain` live in memory and are lost when the server restarts; set `IMAP_SPAM_DOMAINS` and `IMAP_WHITELIST_DOMAINS` for lasting lists. The spam tools take `accountId` only, not `accountName`.

The fallback for servers with a broken SEARCH downloads every envelope of the folder on each search, and refuses a body search above 2000 candidates. Deleting tools never act on a fallback match: they return an error instead.

`allowedFrom` is a guardrail, not a security boundary: a model with access to `imap_update_account` can change it. The SMTP server decides who may send as whom.

Prompt-injection defences are tested at the protocol level, not against real models. Read-only mode protects the mailbox and the configuration; it cannot stop a model from exporting what it read through another tool of the host.

## Development

```sh
npm run dev      # server from source, reloads on change
npm run build    # bundle to dist/ with esbuild
npm test         # vitest
npm run lint     # tsc --noEmit
```

`tsc` needs a large heap on this project: `node --max-old-space-size=8192 ./node_modules/typescript/bin/tsc --noEmit`. Tests use an in-memory credential store and never touch the real keychain.

## Project

| Path | Purpose |
| --- | --- |
| `src/index.ts` | MCP server over stdio, tool registration |
| `src/tools` | Tool definitions (`imap_*`): accounts, email, folders, spam |
| `src/services` | IMAP (imapflow), SMTP (nodemailer), account store, keychain, spam analysis |
| `src/providers` | Provider catalogue and user overrides |
| `src/utils` | Attachments, untrusted-content envelope, reply headers, send-as, TLS CA |
| `src/web`, `public` | Setup wizard (Express, loopback only) |
| `tests` | Vitest suite |
| `docs` | Documentation |

## Documentation

- [Accounts](docs/accounts.md): wizard, keychain, migration from encrypted files, provider catalogue, local bridges, aliases.
- [Configuration](docs/configuration.md): environment variables, read-only mode, allowlists.
- [Tools](docs/tools.md): every tool, its parameters and its behaviour.
- [Untrusted content](docs/untrusted-content.md): result envelope, output budget, host requirements.
- [Troubleshooting](docs/troubleshooting.md): connection errors, providers, server quirks.
- [Architecture](docs/architecture.md): services, connection lifecycle, account store.
- [AGENTS.md](AGENTS.md): conventions and rules for contributors and coding agents.

## Licence

MIT. The original copyright notice is kept in [LICENSE](LICENSE), with a second line for the changes made in this fork. Michael Nikolaus has not reviewed or endorsed this fork: report issues here, not upstream.
