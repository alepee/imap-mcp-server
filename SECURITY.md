# Security Policy

`imap-mcp-server` connects AI assistants to your email. Because email is highly
sensitive, the project is designed to keep your data **local and under your
control**.

## Security model

- **Local execution.** The server runs entirely on your own machine as a local
  MCP process (stdio). It is not a hosted service and does not require any
  account with this project.
- **Credential storage.** IMAP/SMTP credentials are stored encrypted with
  **AES-256-CBC** in `~/.imap-mcp/accounts.json`. The encryption key is generated
  locally and kept at `~/.imap-mcp/.key`. The store directory and both files are
  written owner-only (`0700`/`0600`) so other local users cannot read them;
  anyone who can read both files can read your credentials.
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

- **Preferred:** use GitHub's **[Report a vulnerability](https://github.com/nikolausm/imap-mcp-server/security/advisories/new)**
  (Security → Advisories) to open a private advisory. Private vulnerability
  reporting is enabled on this repository, so this form works and routes the
  report only to the maintainer.
- **By email:** write to **security.imap-mcp-server@minicon.eu**. Please do not
  include exploit details in an unencrypted first email if you can avoid it —
  a heads-up plus a request for a secure channel is enough to get started.
- **If neither is available to you:** open a regular GitHub issue that says only
  that you have a security report and asks for a private contact channel —
  **without** any details, reproduction steps, or exploit information. The
  maintainer will follow up privately.

Please include reproduction steps and affected versions in the private report.
We aim to acknowledge reports promptly, investigate, and ship a fix with a
coordinated disclosure once a patch is available. Thank you for helping keep
users safe.
