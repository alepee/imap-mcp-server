# Troubleshooting

Start with `imap_test_account`: it connects with the stored credentials and reports the server's error as is. The server's own diagnostics go to stderr, which most MCP clients keep in their logs (Claude Desktop: `~/Library/Logs/Claude/mcp-server-imap.log` on macOS).

## Authentication fails

- Most large providers refuse your usual password over IMAP. Gmail, iCloud, Yahoo, Fastmail and AOL need an app password; the wizard shows where to create one for each provider.
- Some need IMAP turned on first: Gmail (Forwarding and POP/IMAP), GMX and WEB.DE (POP3 & IMAP), Zoho (IMAP Access).
- The error returned for a catalogue provider ends with the hint for that provider.

## Certificate or TLS errors

| Error | Cause |
| --- | --- |
| `DEPTH_ZERO_SELF_SIGNED_CERT`, `self-signed certificate` | Local bridge or private server: set `tlsCa`, see [local bridges](accounts.md#local-bridges) |
| `wrong version number` | Implicit TLS against a STARTTLS port: set `tls: false` |
| STARTTLS not offered | The server does not advertise STARTTLS on that port. This fork never falls back to cleartext: use the implicit TLS port (usually 993) |
| Hostname mismatch | The certificate does not cover the host you configured. Use the provider's canonical host rather than an alias |

## Keychain errors

- macOS: allow access when prompted. A denied prompt can be reset from Keychain Access, entries under `io.github.nikolausm.imap-mcp-server`.
- Linux: the Secret Service must be running and unlocked on the D-Bus session the server sees. An MCP client started outside your desktop session (systemd unit, SSH) may not reach it.
- `accounts.json.lock` left behind after a crash: stop every server and wizard, then delete the lock directory. It is never removed automatically.

## Claude Desktop shows "Connection closed"

The configured command did not start. Use absolute paths for both `node` and `dist/index.js` (the wizard writes them), and check that `npm run build` produced `dist/index.js`. Apps started from the macOS GUI do not inherit the shell `PATH`, so a bare `node` from nvm or Homebrew may not be found.

## Search returns nothing

On Strato (`imap.strato.com`), SEARCH returns an empty result for everything while FETCH works. The server detects it and filters envelopes itself, which is slower and refuses body searches above 2000 candidates: narrow them with `since`, `from` or `subject`. Criteria deletes return an error on such servers; delete by UID instead.

Elsewhere, check the folder name with `imap_list_folders` (it varies by provider and language), or search all folders with `searchAllFolders`.

## Recipients arrive as `["a@x.com","b@y.com"]`

The MCP client flattened an array into a string. The server repairs it and logs a warning; passing one comma-separated string avoids it. See [tools](tools.md#recipients-turned-into-axcombycom).

## The Sent copy is missing

The result of a send says why: `savedToSent: false` with `sentSaveError`. Usually the server has no `\Sent` folder and none of the known names matched: set `sentFolder` on the account. `saveToSent: false` turns the copy off on purpose.

## Attachments are refused

Attachment paths must be inside `IMAP_DOWNLOAD_DIR` (default `~/Downloads/imap-attachments`); URLs, symlinks and special files are refused, and an explicit `savePath` never overwrites a file. Copy the file there, or send it with `imap_upload_file`.
