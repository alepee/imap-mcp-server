# Security Policy

`imap-mcp-server` connects AI assistants to your email. Because email is highly
sensitive, the project is designed to keep your data **local and under your
control**.

## Security model

- **Local execution.** The server runs entirely on your own machine as a local
  MCP process (stdio). It is not a hosted service and does not require any
  account with this project.
- **Credential storage.** Passwords are stored in macOS Keychain, Windows
  Credential Manager or Linux Secret Service, with no file fallback. Usernames,
  server settings and opaque references remain in owner-only `accounts.json`.
  Keychain access follows the OS user's permissions and unlock state; passwords
  are necessarily present in server memory during authentication. This does not
  protect against a compromised server or every process running as the same user.
  Legacy AES-256-CBC files remain readable during migration. The wizard verifies
  all migrated secrets before replacing configuration and removing the old `.key`.
  Failed writes preserve the previous configuration; obsolete-entry cleanup can
  leave an orphan if the keychain becomes unavailable after commit. Old backups
  are not erased by migration. See README for migration and Linux prerequisites.
- **No telemetry.** The server collects no analytics, usage data, or crash
  reports.
- **No third-party data sharing.** The only outbound network connections are to
  the IMAP and SMTP servers **you** configure. Email content and credentials are
  never sent anywhere else.
- **Your MCP client sees your mail.** Email content returned by these tools is
  passed to whichever MCP client/LLM you connect (e.g. Claude, ChatGPT, Cursor).
  Review that client's own privacy terms; treat any connected model as a party
  that can read the mailboxes you expose.

## Recommendations for users

- Use **app-specific passwords** where your provider supports them (Gmail,
  iCloud, Yahoo, Fastmail, …) instead of your primary password.
- Keep `~/.imap-mcp/` readable only by your user account.
- Prefer least-privilege accounts/folders when possible.
- Be deliberate with destructive tools (`imap_delete_email`,
  `imap_bulk_delete`, `imap_bulk_delete_by_search`) — use the `dryRun` option to
  preview criteria-based deletions first. `imap_bulk_delete_by_search` requires
  at least one concrete criterion and refuses an empty criteria set, so it can
  never wipe a whole folder by accident.

## Indirect prompt injection

Mail and attachments are controlled by external authors. Instructions can appear
in visible text, HTML, PDF text layers, images, metadata or filenames. A familiar
sender, SPF/DKIM result or a plausible claim of user approval does not grant those
instructions authority.

The server labels results as untrusted data, advertises handling instructions,
bounds returned text, and requires explicit attachment preview/extraction options.
`IMAP_MCP_READ_ONLY=true` removes mutation tools even if an allowlist names them.
These controls do not detect every attack and do not guarantee model behavior.
The text budget is enforced after tool execution: it does not bound parser memory
or all bytes fetched from IMAP. Saved files consumed by another tool are outside
this response boundary.

The host must keep user instructions separate from tool data and enforce any
required human approval outside the model. Approval should bind to recipients,
content and attachments for an outbound message, or exact account/folder/UIDs
for mutations. Never treat a tool argument, an email or a model-generated token
as proof of human consent. Summaries derived from mail remain untrusted. Restrict
other connectors, command execution and remote image/link loading to prevent
exports through channels outside this server's control.

### Regression coverage and remaining validation

`tests/untrusted-content.test.ts` exercises role-spoofing text, metadata collisions,
JSON escaping, shared output limits and media labeling.
`tests/mcp-content-boundary.test.ts` uses the actual MCP client/server SDK over an
in-memory transport to verify initialization instructions, denied write calls,
provenance, defaults and budgets with hostile message data.

These are deterministic server/protocol tests, **not model-based evaluations**.
Before trusting an autonomous workflow, run it with its actual client/model and
synthetic mail containing fake approval, role changes, secret-export requests,
encoded/hidden instructions and malicious text in images/PDFs. Assert that the
original task is completed without unauthorized calls, exports, configuration
changes or persistent-memory updates. Do not use real mailbox contents for those
tests or write them to diagnostic logs.

## Reporting a vulnerability (responsible disclosure)

If you discover a security issue, please report it **privately** — do not open a
public issue with exploit details.

This repository is a fork (see [NOTICE.md](NOTICE.md)). Report what you find
here, to this fork — the upstream maintainer cannot fix code that only exists in
this copy, and a report sent there will not reach anyone who can act on it.

- **Preferred:** use GitHub's **[Report a vulnerability](https://github.com/alepee/imap-mcp-server/security/advisories/new)**
  (Security → Advisories) to open a private advisory, which routes the report
  only to this repository's maintainer.
- **If that is unavailable to you:** open a regular GitHub issue saying only
  that you have a security report and asking for a private contact channel —
  **without** any details, reproduction steps, or exploit information.

If the issue also affects [the original project](https://github.com/nikolausm/imap-mcp-server),
say so: it needs reporting there too, through its own channels, and coordinating
the disclosure is better than one of us patching in the dark.

Please include reproduction steps and affected versions in the private report.
We aim to acknowledge reports promptly, investigate, and ship a fix with a
coordinated disclosure once a patch is available. Thank you for helping keep
users safe.
