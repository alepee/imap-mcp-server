import { readFileSync } from 'fs';
import path from 'path';
import os from 'os';

const PEM_PREFIX = '-----BEGIN';

/**
 * Resolve an account's `tlsCa` into PEM text for Node's TLS layer.
 *
 * Accepts either the PEM itself (pasted into the account) or a path to a `.pem`
 * file, with a leading `~` expanded. A path is read at connection time rather
 * than cached, so replacing a rotated certificate on disk takes effect without
 * touching the stored account.
 *
 * Throws with the offending path when the file cannot be read: a silently
 * dropped CA would resurface as an opaque self-signed-certificate error at
 * handshake time, which is exactly the confusion this option exists to remove.
 */
export function resolveTlsCa(value: string | undefined): string | undefined {
  if (!value) return undefined;

  const trimmed = value.trim();
  if (trimmed === '') return undefined;
  if (trimmed.startsWith(PEM_PREFIX)) return trimmed;

  const expanded = trimmed.startsWith('~')
    ? path.join(os.homedir(), trimmed.slice(1))
    : trimmed;

  try {
    return readFileSync(expanded, 'utf-8');
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    throw new Error(`Cannot read the TLS CA certificate at "${expanded}": ${reason}`);
  }
}
