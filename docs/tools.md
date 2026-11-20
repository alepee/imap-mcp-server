# Tools

40 tools, all prefixed `imap_`. Their names and input shapes are a public contract: they change only additively. Every result is JSON text wrapped in the [untrusted-content envelope](untrusted-content.md). The tools marked **R** are the ones kept in [read-only mode](configuration.md#read-only-mode).

## Choosing an account

The account, email and folder tools take `accountId` or `accountName`. With a single configured account, both can be left out. With several accounts and no selector, the tool fails with the list of accounts. The spam tools take `accountId` only.

## Accounts

| Tool | | Purpose |
| --- | --- | --- |
| `imap_add_account` | | Add an account; the password goes to the keychain. Fields in [accounts](accounts.md#account-fields), plus `provider` to fill the gaps from the catalogue |
| `imap_update_account` | | Change any field of an account. Omitted SMTP credentials are kept; empty values clear `sentFolder`, `defaultBcc`, `tlsCa`, `allowedFrom` |
| `imap_remove_account` | | Remove an account and its keychain entries |
| `imap_list_accounts` | R | List accounts, without unlocking the keychain |
| `imap_connect`, `imap_disconnect` | R | Open or close the account's IMAP connection |
| `imap_test_account` | R | Connect with the stored credentials; returns folder and message counts |

## Reading

### `imap_search_emails` (R)

| Parameter | Default | |
| --- | --- | --- |
| `folder` | `INBOX` | Ignored with `searchAllFolders` |
| `searchAllFolders` | false | Search every selectable folder. Trash, Spam and Drafts are skipped unless `includeTrash`, `includeSpam`, `includeDrafts` |
| `from`, `to`, `subject`, `body` | | Text criteria |
| `since`, `before` | | Dates |
| `seen`, `flagged` | | Status |
| `keywords`, `unKeywords` | | Messages with any of these custom keywords, or with none of them. A folder's keywords are listed by `imap_folder_status` |
| `limit` | 50 | |
| `includeBody`, `bodyFormat`, `bodyMaxLength` | false, `markdown`, 10000 | Return parsed bodies with the results, in one round trip. Single-folder searches only |

A cross-folder search adds `folder` to each result, plus `foldersSearched` and `foldersErrored`, so an empty answer is never silently partial.

Some servers mark a starred message with a custom keyword (Open-Xchange `$cl_N`, Apple Mail `$MailFlagBit*`) instead of, or as well as, `\Flagged`. After a flagged search, check each result's `customKeywords`.

### Other reading tools

| Tool | | Purpose |
| --- | --- | --- |
| `imap_get_email` | R | One message by `folder` and `uid`: body (`bodyFormat`, default Markdown, raw HTML omitted), addresses including `cc` and `replyTo`, `references`, attachment list. `maxContentLength` (default 10000, max 32000), `includeHeaders`, `includeAttachmentText` with `maxAttachmentTextChars` |
| `imap_get_latest_emails` | R | The `count` (default 10) newest messages of a folder, with the same `includeBody` options as search |
| `imap_find_thread_messages` | R | Messages of `searchFolder` (default `INBOX`) belonging to the threads already in `sourceFolder`, through `In-Reply-To` and, with `searchReferences` (default true), `References` |
| `imap_find_email_by_message_id` | R | Locate a message by its Message-ID (angle brackets optional) across folders, or in `folders` in the given order; returns its current folder and UID |
| `imap_download_attachment` | R | Save one attachment, named by `filename` or content ID as listed by `imap_get_email`. Accented names match in NFC or NFD form. `savePath` must be inside `IMAP_DOWNLOAD_DIR` and must not exist. `extractText` (PDF, bounded by `maxExtractedTextChars`) and `inlineImage` (up to 5 MiB) are off by default |

## Writing

### `imap_send_email`

| Parameter | |
| --- | --- |
| `to`, `cc`, `bcc` | An array, or one comma-separated string. `"Name <addr@example.com>"` is accepted |
| `from` | Optional alias, checked against the account (see [send-as aliases](accounts.md#send-as-aliases)) |
| `subject`, `text`, `html` | `body` is an alias of `text` |
| `replyTo` | |
| `attachments` | Each with `filename` and either `content` (base64, line breaks allowed) or `path` inside `IMAP_DOWNLOAD_DIR`. Optional `contentType`; `contentDisposition: "inline"` with a `cid` for images referenced as `cid:` in `html` |

After sending, a copy is appended to the Sent folder unless the account has `saveToSent: false`. The folder comes from the account's `sentFolder`, then the server's `\Sent` special-use flag, then known localized names. The result reports `savedToSent`, `sentFolder`, and `sentSaveError` when the copy failed. The account's `defaultBcc` is always added.

### Other writing tools

| Tool | Purpose |
| --- | --- |
| `imap_reply_to_email` | Reply to `folder` + `uid`. Sets `Re:`, `In-Reply-To` and the full `References` chain. `replyAll` adds the original To and Cc, honours `Reply-To`, and leaves out your own addresses and duplicates |
| `imap_forward_email` | Forward `folder` + `uid` to `to`, quoting the original; `includeAttachments` defaults to true |
| `imap_save_draft` | Same fields as `imap_send_email` plus `inReplyTo`, `references` and a `folder` override; stored without sending |
| `imap_upload_file` | Store a base64 file in `IMAP_DOWNLOAD_DIR` and return its path, to attach large files without passing them through every call. Limited by `IMAP_MAX_UPLOAD_SIZE`, deleted after `IMAP_UPLOAD_TTL_MS` |

Reply, forward and draft accept `from` and `bcc` like `imap_send_email`, and reply also takes `attachments`. Reply and forward save a Sent copy the same way.

## Sorting

| Tool | Purpose |
| --- | --- |
| `imap_mark_as_read`, `imap_mark_as_unread` | One UID or an array, in a single STORE |
| `imap_flag_email`, `imap_unflag_email` | Set or clear `\Flagged` (the star). Unflag does not clear provider keywords: check `customKeywords` and use `imap_remove_keyword` |
| `imap_add_keyword`, `imap_remove_keyword` | Set or clear a custom keyword, passed verbatim (`$cl_3`, `$MailFlagBit0`, `$promotion`). System flags (`\Seen`, `\Deleted`…) are refused. Fails if the server rejects or ignores the change |
| `imap_move_email` | Move one UID or an array to `targetFolder`; `createDestinationIfMissing` creates it. Batch moves report a result per UID |

## Deleting

| Tool | Purpose |
| --- | --- |
| `imap_delete_email` | Delete one message (moved to Trash or expunged, depending on the server) |
| `imap_bulk_delete` | Delete a list of `uids` in chunks of `chunkSize` (1 to 1000, default 50), reconnecting if needed |
| `imap_bulk_delete_by_search` | Delete what matches `from`, `to`, `subject`, `since`, `before`. At least one criterion is required, so a whole folder can never be deleted by an empty call. `dryRun` previews |

Criteria-based deletes (`imap_bulk_delete_by_search`, `imap_delete_spam`, `imap_delete_by_domain`) refuse to run on a server whose SEARCH is broken, rather than delete from a client-side match. Find the messages with `imap_search_emails`, then delete their UIDs with `imap_bulk_delete`.

## Folders

| Tool | | Purpose |
| --- | --- | --- |
| `imap_list_folders` | R | Names, delimiter, raw attributes and RFC 6154 `specialUse` role (`\Sent`, `\Drafts`, `\Trash`, `\Junk`, `\Archive`), whatever the localized name |
| `imap_folder_status` | R | Message counts (total, new, unseen), `uidvalidity`, `uidnext`, flags, permanent flags and `customKeywords` |
| `imap_get_unread_count` | R | Unread count per folder and in total; all folders unless `folders` is given |
| `imap_create_folder` | | Create a folder by full path (`Archives/2026` or `INBOX.Archive`); succeeds if it already exists |

## Spam

| Tool | | Purpose |
| --- | --- | --- |
| `imap_check_spam` | R | Score up to `limit` (default 100) messages of a folder from their sender domain and, with `includeHeaderChecks` (default true), raw headers: bulk mailers, `Precedence: bulk`, DMARC/SPF/DKIM failures |
| `imap_domain_stats` | R | Sender domains of a folder with at least `minCount` messages |
| `imap_list_spam_domains` | R | Built-in and custom spam domains |
| `imap_delete_spam` | | Delete messages detected as spam at `minConfidence` or above (default `high`). `dryRun` defaults to true |
| `imap_delete_by_domain` | | Delete every message from `domain`. `dryRun` defaults to true |
| `imap_add_spam_domain`, `imap_remove_spam_domain`, `imap_add_whitelist_domain` | | Edit the custom lists, in memory until the server restarts. Use `IMAP_SPAM_DOMAINS` and `IMAP_WHITELIST_DOMAINS` for lasting lists |

## Recipients turned into `["a@x.com","b@y.com"]`

Fields that take one value or an array (`to`, `cc`, `bcc`, `references`, `uid`) are a JSON Schema `anyOf`. Some MCP clients drop the `anyOf` and send the model's array as a string. The server recognises a stringified array, restores it, and logs a warning naming the field. To sidestep the client entirely, pass recipients as one comma-separated string.
