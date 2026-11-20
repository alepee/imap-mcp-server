# Security

This server hands your mail to an AI model. It is built to keep that mail, and the credentials that open it, on your machine.

## Security model

- **Local.** The server runs on your machine as a stdio MCP process. There is no hosted service and no account with this project.
- **Credentials.** Passwords live in macOS Keychain, Windows Credential Manager or Linux Secret Service, with no file fallback. Settings, usernames and opaque references live in `~/.imap-mcp/accounts.json`, owner-only. Keychain access follows your session's permissions and unlock state. Passwords are in the server's memory while it authenticates: the keychain does not protect them from a compromised server, or from every process running as your user. Legacy accounts encrypted with AES-256-CBC stay readable until migrated; see [accounts](docs/accounts.md#migrating-from-encrypted-files).
- **Transport.** IMAP requires TLS, implicit or through a STARTTLS upgrade that fails rather than continuing in cleartext. SMTP on 587 and 25 requires STARTTLS.
- **Network.** No telemetry, analytics or crash reports. The only outbound connections are to the IMAP and SMTP servers you configure. The setup wizard listens on loopback only.
- **Files.** Attachments are read from and written to `IMAP_DOWNLOAD_DIR` only. Symlinks, special files and URLs are refused, and existing files are never overwritten.
- **Your MCP client reads your mail.** Whatever these tools return goes to the client and model you connect. Their own terms apply: treat that model as a party that can read every mailbox you expose.

## Prompt injection

Mail is written by people you do not control, and its content can carry instructions aimed at the model. The server labels results as untrusted, bounds their size, keeps attachment previews off by default, and lets read-only mode remove every write tool. It cannot guarantee how a model behaves: human approval for sending, deleting and changing accounts must be enforced by the host. [Untrusted content](docs/untrusted-content.md) describes the envelope, the budget, the host requirements and what the tests cover.

## Recommendations

- Use app passwords where your provider offers them, rather than your main password.
- Add accounts with the setup wizard. A password passed to `imap_add_account` goes through the model and the client logs.
- Start with `IMAP_MCP_READ_ONLY=true`, and expose write tools only to workflows that need them.
- Preview criteria deletes with `dryRun`. `imap_bulk_delete_by_search` refuses a call without criteria, so it cannot empty a folder.
- Keep `~/.imap-mcp/` readable by your user only, and back up the keychain with it.

## Reporting a vulnerability

Report privately, never in a public issue with details.

This repository is a fork (see [NOTICE.md](NOTICE.md)). Report here: the upstream maintainer cannot fix code that only exists in this copy.

- Preferred: GitHub's [Report a vulnerability](https://github.com/alepee/imap-mcp-server/security/advisories/new), which opens a private advisory visible to this repository's maintainer only.
- Otherwise: open an issue that only says you have a security report and asks for a private channel, without any detail.

If the issue also affects [the original project](https://github.com/nikolausm/imap-mcp-server), say so: it needs reporting there too, through its own channels, and a coordinated disclosure beats patching in the dark.

Include reproduction steps and the affected commit. Reports are acknowledged as soon as possible, and fixes are published with a coordinated disclosure.
