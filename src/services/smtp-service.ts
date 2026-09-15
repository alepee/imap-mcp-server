import nodemailer from 'nodemailer';
import MailComposer from 'nodemailer/lib/mail-composer/index.js';
import { ImapAccount, EmailComposer, SmtpConfig } from '../types/index.js';
import { parseSerializedArray } from '../utils/array-input.js';
import { getProviderById, getProviders } from '../providers/catalogue.js';
import { assertCredentialsResolved } from '../utils/env-credentials.js';

export class SmtpService {
  private transporters: Map<string, nodemailer.Transporter> = new Map();

  async createTransporter(account: ImapAccount): Promise<nodemailer.Transporter> {
    if (this.transporters.has(account.id)) {
      return this.transporters.get(account.id)!;
    }

    // See ImapService.connect: name the missing variable instead of letting the
    // provider reject a blank credential with a generic auth error.
    assertCredentialsResolved(account, 'smtp');

    const smtpConfig = account.smtp || this.getDefaultSmtpConfig(account);
    const { secure, requireTLS } = this.resolveTlsMode(smtpConfig.port, smtpConfig.secure);

    const transporterOptions = {
      host: smtpConfig.host,
      port: smtpConfig.port,
      secure,
      requireTLS,
      auth: {
        user: smtpConfig.user || account.user,
        pass: smtpConfig.password || account.password,
      },
      tls: smtpConfig.tls,
    };

    const transporter = nodemailer.createTransport(transporterOptions);
    
    // Verify connection
    await transporter.verify();
    
    this.transporters.set(account.id, transporter);
    return transporter;
  }

  // Port 465 is implicit TLS (SMTPS); 587/25 are submission ports that upgrade via STARTTLS.
  // A stored `secure: true` on port 587 is almost always a UI mistake — normalize it.
  private resolveTlsMode(port: number, secure: boolean): { secure: boolean; requireTLS: boolean } {
    if (port === 465) return { secure: true, requireTLS: false };
    if (port === 587 || port === 25) return { secure: false, requireTLS: true };
    return { secure, requireTLS: !secure };
  }

  /**
   * SMTP settings for an account that carries none of its own.
   *
   * Resolution order: the account's provider, then an exact match of its IMAP
   * host against the catalogue, then the `imap.` -> `smtp.` rewrite. The first
   * two used to be a private table in this file that disagreed with the wizard's
   * catalogue for five providers (Gmail, Yahoo, AOL and Fastmail on the port,
   * Outlook on the host itself). There is now one source.
   */
  private getDefaultSmtpConfig(account: ImapAccount): SmtpConfig {
    const fromCatalogue =
      getProviderById(account.provider)?.smtp ??
      getProviders().find(p => p.imap?.host === account.host)?.smtp;

    if (fromCatalogue) {
      return {
        host: fromCatalogue.host,
        port: fromCatalogue.port,
        secure: fromCatalogue.security === 'implicit',
      };
    }

    // Unknown host: guess the SMTP name, and default to submission with a
    // mandatory STARTTLS upgrade (resolveTlsMode turns port 587 into
    // requireTLS).
    const smtpHost = account.host.startsWith('imap.') || account.host.startsWith('imap-')
      ? account.host.replace(/^imap[.-]/, (m) => m === 'imap.' ? 'smtp.' : 'smtp-')
      : account.host;
    return {
      host: smtpHost,
      port: 587,
      secure: false,
    };
  }

  // Last line of defense against an address list that was serialized into a
  // string somewhere between the caller and here (see utils/array-input.ts).
  // nodemailer would otherwise fold the literal brackets into the first and
  // last address and every recipient bounces, so recover the array instead.
  private static addresses(
    value: string | string[] | undefined,
    field: string
  ): string | string[] | undefined {
    return parseSerializedArray(value, field) as string | string[] | undefined;
  }

  private toMailOptions(account: ImapAccount, email: EmailComposer): nodemailer.SendMailOptions {
    const references = SmtpService.addresses(email.references, 'references');
    return {
      from: email.from || account.email || account.user,
      to: SmtpService.addresses(email.to, 'to'),
      cc: SmtpService.addresses(email.cc, 'cc'),
      bcc: SmtpService.addresses(email.bcc, 'bcc'),
      subject: email.subject,
      text: email.text,
      html: email.html,
      attachments: email.attachments?.map(att => ({
        filename: att.filename,
        content: att.content,
        path: att.path,
        contentType: att.contentType,
        contentDisposition: att.contentDisposition,
        cid: att.cid,
      })),
      replyTo: email.replyTo,
      inReplyTo: email.inReplyTo,
      references: Array.isArray(references) ? references.join(' ') : references,
    };
  }

  // Build the raw RFC 822 message without sending. Used for drafts and Sent-folder copies.
  // keepBcc is required: MailComposer omits Bcc from the MIME by default (SMTP
  // envelope-only). Without it, imap_save_draft and Sent-folder copies drop
  // Bcc even when resolveBcc / defaultBcc injected recipients into email.bcc.
  async composeRaw(account: ImapAccount, email: EmailComposer): Promise<Buffer> {
    const message = new MailComposer(this.toMailOptions(account, email)).compile();
    message.keepBcc = true;
    return message.build();
  }

  async sendEmail(accountId: string, account: ImapAccount, email: EmailComposer): Promise<{ messageId: string; rawMessage?: Buffer }> {
    try {
      const transporter = await this.createTransporter(account);
      const mailOptions = this.toMailOptions(account, email);

      // Build raw message for IMAP Sent folder append
      let rawMessage: Buffer | undefined;
      try {
        rawMessage = await this.composeRaw(account, email);
      } catch {
        // Non-critical: sent folder copy will be skipped
      }

      const info = await transporter.sendMail(mailOptions);
      return { messageId: info.messageId, rawMessage };
    } catch (error) {
      throw new Error(`Failed to send email: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }

  async verifySmtpConnection(account: ImapAccount): Promise<boolean> {
    try {
      const transporter = await this.createTransporter(account);
      await transporter.verify();
      return true;
    } catch (error) {
      return false;
    }
  }

  disconnect(accountId: string): void {
    const transporter = this.transporters.get(accountId);
    if (transporter) {
      transporter.close();
      this.transporters.delete(accountId);
    }
  }

  disconnectAll(): void {
    for (const [accountId, transporter] of this.transporters) {
      transporter.close();
    }
    this.transporters.clear();
  }
}