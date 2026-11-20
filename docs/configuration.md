# Configuration

The server reads its settings from environment variables, set under `env` in the MCP client configuration. They are read once at startup: restart the client after a change. A `.env` file in the server's working directory is read too. Account settings are not configured here, see [accounts](accounts.md).

## Variables

| Variable | Default | Effect |
| --- | --- | --- |
| `IMAP_MCP_READ_ONLY` | off | `true`, `1`, `yes` or `on`: register only the read tools (see below). Any other value than a recognised true or false stops the server |
| `IMAP_MCP_ENABLED_TOOLS` | all | Comma-separated allowlist. Case-insensitive, `imap_` prefix optional. Unknown names are reported on stderr. An empty value enables no tool |
| `IMAP_MCP_MAX_RESULT_CHARS` | `32000` | Budget, in characters of serialized JSON, shared by all text blocks of one tool result. Integer from 1000 to 200000; anything else stops the server. See [untrusted content](untrusted-content.md#output-budget) |
| `IMAP_DOWNLOAD_DIR` | `~/Downloads/imap-attachments` | The only directory attachments are saved to and read from |
| `IMAP_MAX_UPLOAD_SIZE` | `26214400` (25 MiB) | Maximum size, in bytes, of a file sent with `imap_upload_file` |
| `IMAP_UPLOAD_TTL_MS` | `86400000` (24 h) | Uploaded files are deleted after this delay |
| `IMAP_SPAM_DOMAINS` | none | Comma-separated domains always treated as spam |
| `IMAP_WHITELIST_DOMAINS` | none | Comma-separated domains never treated as spam |
| `PORT` | `3000` | Port of the setup wizard started with `npm run web`. `imap-setup` takes `--port` instead |
| `IMAP_MCP_ACCOUNT_<NAME>_*` | none | Credential overrides for legacy accounts only, see [accounts](accounts.md#migrating-from-encrypted-files) |

## Read-only mode

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

Read-only mode registers these tools, and only these:

| Area | Tools |
| --- | --- |
| Accounts | `imap_list_accounts`, `imap_connect`, `imap_disconnect`, `imap_test_account` |
| Email | `imap_search_emails`, `imap_get_email`, `imap_get_latest_emails`, `imap_download_attachment`, `imap_find_thread_messages`, `imap_find_email_by_message_id` |
| Folders | `imap_list_folders`, `imap_folder_status`, `imap_get_unread_count` |
| Spam | `imap_check_spam`, `imap_domain_stats`, `imap_list_spam_domains` |

None of them sends mail, changes a flag, moves or deletes a message, or edits an account or a spam list. `imap_download_attachment` still writes files into `IMAP_DOWNLOAD_DIR`: read-only protects the mailbox and the configuration, not the local disk.

## Allowlist

```json
"env": { "IMAP_MCP_ENABLED_TOOLS": "search_emails,get_email,get_latest_emails" }
```

Read-only mode is a ceiling: combined with an allowlist, only the tools present in both are registered. An allowlist can narrow read-only mode, never widen it. A tool that is not registered does not exist for the client; a call to it fails at the protocol level.
