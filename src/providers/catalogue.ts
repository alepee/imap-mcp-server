import { readFileSync } from 'fs';
import path from 'path';
import os from 'os';
import { z } from 'zod';
import builtInCatalogue from './providers.json';

/**
 * Connection security for one leg (IMAP or SMTP).
 *
 * Replaces the old `'TLS' | 'SSL' | 'STARTTLS'` triple, whose first two values
 * were indistinguishable: every consumer collapsed it to `!== 'STARTTLS'`.
 * `starttls` means the upgrade is mandatory, never opportunistic.
 */
export const securitySchema = z.enum(['implicit', 'starttls']);
export type Security = z.infer<typeof securitySchema>;

const endpointSchema = z.object({
  host: z.string().min(1),
  port: z.number().int().positive(),
  security: securitySchema,
});

/**
 * A provider entry.
 *
 * `imap` and `smtp` are required, and deliberately so: the user overlay
 * replaces a record whole rather than merging field by field, so a schema that
 * tolerated a missing `smtp` would let a partial override silently produce a
 * provider that cannot send mail. The one exception is a `manual` entry (the
 * "Custom/Other" tile), which carries no connection settings by definition.
 */
const providerSchema = z.object({
  id: z.string().min(1),
  displayName: z.string().min(1),
  domains: z.array(z.string()).default([]),
  imap: endpointSchema.optional(),
  smtp: endpointSchema.optional(),
  auth: z.object({
    appPassword: z.boolean().optional(),
    oauth2: z.boolean().optional(),
    helpUrl: z.string().optional(),
    notes: z.string().optional(),
  }).optional(),
  hints: z.object({
    authFailure: z.string().optional(),
  }).optional(),
  ui: z.object({
    iconUrl: z.string().optional(),
    color: z.string().optional(),
  }).optional(),
  /** Manual-entry tile: the user supplies host and port themselves. */
  manual: z.boolean().optional(),
  /** Overlay-only: hides a built-in entry. */
  disabled: z.boolean().optional(),
}).refine(
  p => p.manual || p.disabled || (p.imap !== undefined && p.smtp !== undefined),
  { message: 'a provider needs both imap and smtp unless it is manual or disabled' },
);

export type Provider = z.infer<typeof providerSchema>;

export const catalogueSchema = z.object({
  version: z.literal(1),
  providers: z.array(providerSchema),
});

/** Where a user-supplied overlay lives. */
export function userCataloguePath(): string {
  return path.join(os.homedir(), '.imap-mcp', 'providers.json');
}

let cached: Provider[] | undefined;

/**
 * Merge the built-in catalogue with an optional user overlay.
 *
 * Merge is by `id`, replacing a record whole: what the user writes is exactly
 * what applies, and a later change to the built-in entry cannot leak into it.
 * `disabled: true` hides a built-in entry; an unknown `id` is appended.
 */
export function mergeCatalogues(builtIn: Provider[], overlay: Provider[]): Provider[] {
  const byId = new Map(builtIn.map(p => [p.id, p]));
  for (const entry of overlay) {
    if (entry.disabled) {
      byId.delete(entry.id);
      continue;
    }
    byId.set(entry.id, entry);
  }
  return [...byId.values()];
}

/**
 * The effective catalogue. Loaded once per process.
 *
 * A missing overlay is the normal case (`npx`, fresh install). An invalid one
 * is reported on stderr and ignored rather than fatal: under the template model
 * no live connection depends on the catalogue, so refusing to start would deny
 * service over a cosmetic file.
 */
export function getProviders(): Provider[] {
  if (cached) return cached;

  const builtIn = catalogueSchema.parse(builtInCatalogue).providers;

  let overlay: Provider[] = [];
  try {
    const raw = readFileSync(userCataloguePath(), 'utf-8');
    overlay = catalogueSchema.parse(JSON.parse(raw)).providers;
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code !== 'ENOENT') {
      console.error(
        `[imap-mcp] Ignoring ${userCataloguePath()}: ${err instanceof Error ? err.message : String(err)}`
      );
    }
  }

  cached = mergeCatalogues(builtIn, overlay);
  return cached;
}

/** Test seam: drop the cached catalogue. */
export function resetCatalogueCache(): void {
  cached = undefined;
}

export function getProviderById(id: string | undefined): Provider | undefined {
  if (!id) return undefined;
  return getProviders().find(p => p.id === id);
}

/**
 * Best-effort match of an address to a provider.
 *
 * Only ever a *suggestion* for the wizard: an account records the provider the
 * user picked, so nothing downstream re-derives it from a domain. That guessing
 * is what silently rewrote STARTTLS accounts before (#7).
 */
export function getProviderByEmail(email: string): Provider | undefined {
  const domain = email.split('@')[1]?.toLowerCase();
  if (!domain) return undefined;
  return getProviders().find(p => p.domains.some(d => domain.endsWith(d)));
}
