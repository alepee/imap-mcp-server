# Notice of origin

This repository is a fork of **[nikolausm/imap-mcp-server](https://github.com/nikolausm/imap-mcp-server)**, an IMAP/SMTP Model Context Protocol server created by **Michael Nikolaus**.

The original work is licensed under the MIT License, Copyright (c) 2024 Michael Nikolaus. That notice is preserved verbatim in [`LICENSE`](LICENSE), as the licence requires, and this fork is distributed under the same terms. Modifications made here carry an additional copyright line in the same file; they do not change the licence.

Michael Nikolaus has not reviewed, endorsed, or been asked to support this fork. Please do not raise issues with the upstream project for behaviour that originates here.

## What came from upstream

Effectively all of it. The architecture, the tool surface (`imap_*`), the IMAP and SMTP services, the account store, the web setup wizard, the provider presets and the test suite were written upstream. This fork is a set of fixes and additions on top of a working project, not a rewrite.

## What was changed here

Security fixes:

- The setup wizard bound every network interface, leaving its unauthenticated account API reachable from the local network behind a `Host` header check that a caller controls. It now binds loopback.
- IMAP connections accepted imapflow's opportunistic STARTTLS default, which falls back to cleartext when a server does not advertise the upgrade. The upgrade is now required.
- Account passwords moved from AES-256-CBC in a file, with the key stored beside it, to the operating system's keychain.
- Attachment handling, credential preservation on update, and account-store writes were hardened; the untrusted-mail context handed to a model is now bounded, with a read-only ceiling that cannot be raised by a tool call.

Correctness and consistency:

- Editing an account in the wizard silently rewrote STARTTLS accounts to implicit TLS, breaking any local bridge on a rename.
- Provider knowledge lived in three tables that disagreed for five providers. They were replaced by a single declarative catalogue, extensible by the user without forking, and an account now records the provider it was created from instead of having it guessed from the email domain.
- Accounts can carry a per-account CA certificate, so a local bridge serving a self-signed certificate (Proton Mail Bridge) works without weakening trust process-wide.
- `imap_test_account` accepts `accountName`, like every other account-scoped tool.

Each change is a separate commit, and the pull request it came from records the reasoning and the verification behind it.

## Upstream contributions

Fixes made here that apply to the original project are intended to be offered upstream. Where that has not happened yet, the divergence is a matter of timing, not of intent to hard-fork.
