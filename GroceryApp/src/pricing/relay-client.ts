/**
 * Relay HTTP client — base URL and authenticated GET for relay APIs.
 *
 * The relay URL in settings is a WebSocket URL (ws:// / wss://); its REST
 * endpoints live on the same host. Authenticated routes take the device's
 * relayToken (minted at enrollment) as a Bearer token.
 */

import { getSettings } from '../config/settings';
import { getRelayToken } from '../identity/enroll';

/** The relay's HTTP base URL, or null when no relay is configured. */
export function getRelayHttpBaseUrl(): string | null {
  const settings = getSettings();
  if (!settings.relayUrl) return null;
  const httpUrl = settings.relayUrl.replace(/^ws:/, 'http:').replace(/^wss:/, 'https:');
  // Only append the port when the URL doesn't already carry one
  const hasPort = /:\d+/.test(httpUrl.replace(/^https?:\/\//, ''));
  if (hasPort) return httpUrl;
  return `${httpUrl}:${settings.relayPort || 8080}`;
}

export class RelayRequestError extends Error {
  constructor(message: string, readonly status?: number) {
    super(message);
  }
}

/**
 * GET an authenticated relay route and parse JSON. Throws RelayRequestError
 * when the relay isn't configured, the device isn't enrolled, or the call
 * fails — callers decide what a failure means for the data they hold.
 */
export async function relayGetJson<T>(pathAndQuery: string, timeoutMs = 15_000): Promise<T> {
  const baseUrl = getRelayHttpBaseUrl();
  if (!baseUrl) throw new RelayRequestError('Relay not configured');
  const relayToken = await getRelayToken();
  if (!relayToken) throw new RelayRequestError('Device not enrolled with the relay');

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(`${baseUrl}${pathAndQuery}`, {
      headers: { Authorization: `Bearer ${relayToken}` },
      signal: controller.signal,
    });
    if (!response.ok) throw new RelayRequestError(`Relay responded ${response.status}`, response.status);
    return (await response.json()) as T;
  } catch (err) {
    if (err instanceof RelayRequestError) throw err;
    throw new RelayRequestError('Relay unreachable');
  } finally {
    clearTimeout(timer);
  }
}
