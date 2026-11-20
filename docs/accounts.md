# Accounts

## Where things live

| What | Where |
| --- | --- |
| Account settings, usernames, keychain references | `~/.imap-mcp/accounts.json` (directory `0700`, file `0600`) |
| Passwords | macOS Keychain, Windows Credential Manager or Linux Secret Service, service `io.github.nikolausm.imap-mcp-server` |
| Provider overrides | `~/.imap-mcp/providers.json` (optional) |
| Downloaded and uploaded attachments | `~/Downloads/imap-attachments`, or `IMAP_DOWNLOAD_DIR` |

Every way of starting the server (wizard, MCP client, `npm run dev`) reads the same store, so an account is set up once.

## Adding an account

### Setup wizard

```sh
npm run setup                 # from the clone
imap-setup                    # after npm install -g
imap-setup --port 3100 --no-open
```

The wizard serves `http://localhost:3000` on `127.0.0.1` only. Pick a provider tile to prefill the IMAP and SMTP settings, enter the password (or app password), and save: the password is written to the keychain, read back to check it, and only then is the account published in `accounts.json`. The wizard API never returns stored passwords to the browser, and a blank password field on edit keeps the current one.

At the end, the wizard offers to register the server in Claude Desktop. `--claude-setup` does it without asking, `--skip-claude` skips it. The entry points at the absolute `node` binary and the absolute `dist/index.js`, because apps started from the macOS GUI do not inherit the shell `PATH`.

### From the assistant

`imap_add_account` takes the same settings. The password is then a tool argument: it goes through the model and ends up in the conversation transcript, the MCP client logs and the context sent to the model provider. Fine for a throwaway test account, not for a real mailbox.

`provider` fills the host, port and security you leave out from the catalogue:

> Add my Fastmail account, provider fastmail, user me@fastmail.com

## Account fields

| Field | Meaning |
| --- | --- |
| `name` | Display name, also usable as `accountName` in every tool |
| `host`, `port`, `tls` | IMAP server. `tls: true` is implicit TLS (usually 993); `tls: false` requires a STARTTLS upgrade (usually 143 or 1143) and fails if the server does not offer it |
| `user`, `password` | IMAP login. The password goes to the keychain |
| `email` | Address used as `From`, when it differs from `user` |
| `smtp` | `host`, `port`, `secure`, optional `user` and `password`. Port 465 always uses implicit TLS, 587 and 25 always require STARTTLS. SMTP inherits the IMAP credentials when it has none |
| `saveToSent` | Save a copy of sent messages (default: true) |
| `sentFolder` | Name of the Sent folder, when the server has no `\Sent` special-use folder. Otherwise it is detected, then guessed from known localized names ("Sent", "Gesendet", "Éléments envoyés"…) |
| `defaultBcc` | Address(es) added in Bcc to every send, reply, forward and draft, merged with the call's `bcc` without duplicates. Kept in the stored copy so mail clients show it |
| `allowedFrom` | Extra addresses accepted as `from` (see [send-as aliases](#send-as-aliases)) |
| `tlsCa` | Extra CA certificate for this account's IMAP TLS (see [local bridges](#local-bridges)) |
| `provider` | Catalogue id the account was created from. Provenance only, never re-resolved |

`imap_update_account` changes any of them. An empty string clears `sentFolder`, `defaultBcc` and `tlsCa`; an empty array clears `allowedFrom`. SMTP credentials left out of an update are preserved. After an update, the account's IMAP and SMTP connections are closed so no session keeps old credentials.

## Passwords and the keychain

Passwords are loaded into memory when a connection authenticates. `imap_list_accounts` and the wizard's account list never unlock the keychain.

Your operating system may ask you to unlock the keychain or allow access. On Linux, the server needs an unlocked Secret Service implementation (GNOME Keyring, KeePassXC with Secret Service enabled…) on a D-Bus session it can reach. Headless sessions must provide one too: there is no fallback to a file or to memory.

Back up the keychain as well as `~/.imap-mcp/`: copying `accounts.json` to another machine does not move the passwords. Third-party password managers are not integrated.

### Migrating from encrypted files

Older versions stored passwords in `accounts.json`, encrypted with AES-256-CBC, with the key in `~/.imap-mcp/.key` beside it. These accounts keep working until they are migrated.

1. Stop every running server and wizard of an older version.
2. Start the wizard and select **Protect saved passwords**.

Every password is written to the keychain and read back before the configuration is replaced. If one fails, nothing changes: the previous file and key stay. When no legacy account is left, `.key` is deleted. Editing a single legacy account in the wizard, or with `imap_update_account`, migrates that account. Older backups of the legacy files are not erased.

Legacy accounts also accept credentials from the environment: `IMAP_MCP_ACCOUNT_<NAME>_IMAP_USERNAME`, `_IMAP_PASSWORD`, `_SMTP_USERNAME`, `_SMTP_PASSWORD`, where `<NAME>` is the account name in upper case with every other character replaced by `_`. They are read at startup and removed from the process environment. Migration imports their effective values; migrated accounts ignore them. Remove them from your MCP configuration afterwards.

## Provider catalogue

Providers are declared in [`src/providers/providers.json`](../src/providers/providers.json), used by the wizard and by the server: IMAP and SMTP settings, the app-password instructions shown during setup, and the hint added to an authentication failure.

| id | IMAP |
| --- | --- |
| `gmail` | `imap.gmail.com:993` |
| `outlook`, `office365` | `outlook.office365.com:993` |
| `yahoo` | `imap.mail.yahoo.com:993` |
| `icloud` | `imap.mail.me.com:993` |
| `fastmail` | `imap.fastmail.com:993` |
| `protonmail` | `127.0.0.1:1143`, STARTTLS (Proton Mail Bridge) |
| `gmx`, `webde`, `ionos`, `mailbox`, `posteo`, `zoho`, `aol` | provider host, 993 |
| `custom` | nothing prefilled |

A provider is a template applied once. The account stores the complete settings and the provider id; nothing is resolved from the catalogue at connection time, and nothing is guessed from the email domain.

To add or replace a provider without forking, create `~/.imap-mcp/providers.json`:

```json
{
  "version": 1,
  "providers": [
    {
      "id": "acme",
      "displayName": "ACME corporate mail",
      "domains": ["acme.example"],
      "imap": { "host": "mail.acme.example", "port": 993, "security": "implicit" },
      "smtp": { "host": "mail.acme.example", "port": 587, "security": "starttls" }
    },
    { "id": "aol", "disabled": true }
  ]
}
```

Entries merge by `id`. A known id replaces the built-in entry as a whole, so what you write is exactly what applies; a new id is added; `"disabled": true` hides a built-in tile. `security` is `implicit` (TLS from the first byte) or `starttls` (upgrade required). An invalid file is reported on stderr and ignored.

## Local bridges

Proton Mail Bridge listens on `127.0.0.1:1143`, requires STARTTLS and serves a self-signed certificate, so a plain account fails with `DEPTH_ZERO_SELF_SIGNED_CERT`. Export the certificate the bridge presents:

```sh
openssl s_client -connect 127.0.0.1:1143 -starttls imap -showcerts </dev/null \
  | awk '/BEGIN CERT/,/END CERT/' > ~/.imap-mcp/proton-bridge-ca.pem
```

Then set `tlsCa` to `~/.imap-mcp/proton-bridge-ca.pem` (a path, with `~` expanded, or the PEM text itself) and keep `tls: false`. With `tls: true` the connection fails with `wrong version number`: a protocol mismatch, not a certificate problem.

`tlsCa` adds trust for that account only. It never turns verification off and never applies to another connection. Prefer it to `NODE_EXTRA_CA_CERTS`, which applies to the whole process: a bridge CA has no name constraints and could then vouch for any host.

## Send-as aliases

`imap_send_email`, `imap_save_draft`, `imap_reply_to_email` and `imap_forward_email` accept a `from`. It is accepted when its address matches the account `email`, the `user` (when it is an address) or an entry of `allowedFrom`, compared case-insensitively. The display name and casing you pass are kept. The value must be exactly one mailbox: lists, groups and line breaks are refused. Reply-all leaves your own aliases out of the recipients.

`allowedFrom` is a guardrail against a model picking an arbitrary sender, not a security boundary. A model allowed to call `imap_update_account` can extend it, and only the SMTP server enforces who may really send as whom.
