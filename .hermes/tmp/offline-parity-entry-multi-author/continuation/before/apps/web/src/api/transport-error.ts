import { ApiError } from './client.js';

const NATIVE_NETWORK_ERROR = /(?:failed to connect to|unable to resolve host|connection (?:refused|timed out|reset)|network (?:error|request failed)|request timed out|err_(?:connection|internet|network|name_not_resolved))/iu;

/**
 * Browser fetch rejects with TypeError, while Capacitor's native HTTP bridge
 * rejects with a plain Error carrying the platform network message. Keep this
 * narrow so validation and authoritative HTTP errors are never hidden behind
 * an offline snapshot.
 */
export function isOfflineTransportError(error: unknown): boolean {
  if (error instanceof TypeError) return true;
  if (error instanceof ApiError) return [502, 503, 504].includes(error.status);
  return error instanceof Error && NATIVE_NETWORK_ERROR.test(error.message);
}
