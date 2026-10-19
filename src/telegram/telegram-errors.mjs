const timeoutCodes = new Set([
  'ETIMEDOUT',
  'ESOCKETTIMEDOUT',
  'UND_ERR_CONNECT_TIMEOUT',
  'UND_ERR_HEADERS_TIMEOUT',
  'UND_ERR_BODY_TIMEOUT',
]);
const dnsCodes = new Set(['ENOTFOUND', 'EAI_AGAIN', 'EAI_FAIL', 'EAI_NODATA']);
const tlsCodes = new Set([
  'CERT_HAS_EXPIRED',
  'CERT_NOT_YET_VALID',
  'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
  'UNABLE_TO_GET_ISSUER_CERT',
  'UNABLE_TO_GET_ISSUER_CERT_LOCALLY',
  'DEPTH_ZERO_SELF_SIGNED_CERT',
  'SELF_SIGNED_CERT_IN_CHAIN',
  'ERR_TLS_CERT_ALTNAME_INVALID',
  'ERR_TLS_CERT_SIGNATURE_ALGORITHM_UNSUPPORTED',
  'ERR_TLS_DH_PARAM_SIZE',
  'ERR_SSL_WRONG_VERSION_NUMBER',
  'ERR_SSL_SSLV3_ALERT_HANDSHAKE_FAILURE',
  'EPROTO',
]);
const networkCodes = new Set([
  'ECONNRESET',
  'ECONNREFUSED',
  'ECONNABORTED',
  'ENETUNREACH',
  'EHOSTUNREACH',
  'EPIPE',
  'UND_ERR_SOCKET',
]);
const field = (value, key) => {
  try {
    return value && typeof value === 'object' ? value[key] : undefined;
  } catch {
    return undefined;
  }
};
const timedOut = (value) =>
  field(value, 'name') === 'TimeoutError' || timeoutCodes.has(field(value, 'code'));
const cancelled = (value) =>
  field(value, 'name') === 'AbortError' || field(value, 'code') === 'ABORT_ERR';

// Only fixed categories leave the transport boundary. Never read exception
// messages, request URLs, response bodies or bot credentials for diagnostics.
export function telegramFailureReason(error, { signal, phase = 'network' } = {}) {
  if (field(signal, 'aborted') === true)
    return timedOut(field(signal, 'reason')) ? 'timeout' : 'cancelled';
  const chain = [];
  let current = error;
  for (
    let depth = 0;
    current && typeof current === 'object' && depth < 4 && !chain.includes(current);
    depth++
  ) {
    chain.push(current);
    current = field(current, 'cause');
  }
  if (chain.some(timedOut)) return 'timeout';
  if (chain.some(cancelled)) return 'cancelled';
  const telegramCode = field(error, 'telegramCode');
  if (Number.isInteger(telegramCode) && telegramCode >= 500) return 'server';
  if (Number.isInteger(telegramCode) && telegramCode >= 400) return 'rejected';
  if (phase === 'attachment') return 'attachment';
  if (phase === 'response-too-large' || phase === 'response-size') return 'response-too-large';
  if (
    phase === 'parsing' ||
    phase === 'parse' ||
    chain.some((item) => field(item, 'name') === 'SyntaxError')
  )
    return 'invalid-response';
  if (chain.some((item) => dnsCodes.has(field(item, 'code')))) return 'dns';
  if (chain.some((item) => tlsCodes.has(field(item, 'code')))) return 'tls';
  if (chain.some((item) => networkCodes.has(field(item, 'code')))) return 'network';
  if (field(error, 'unknownOutcome') === true) return 'unconfirmed';
  return 'network';
}
