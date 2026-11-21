export const smtpDeliveryPolicy = Object.freeze({ maxAttempts: 2, retryDelayMs: 500, retryWindowMs: 15_000 });

export type SmtpFailureKind = 'connection-before-message' | 'temporary-rejection' | 'authentication' | 'configuration' | 'recipient-rejected' | 'permanent-rejection' | 'uncertain';

/** Only metadata from the pinned Nodemailer transport; never parse or expose its response text. */
export function classifySmtpFailure(error: unknown): { kind: SmtpFailureKind; retryable: boolean } {
  if (!error || typeof error !== 'object') return { kind: 'uncertain', retryable: false };
  const { code, command, originalCode, timeoutType, responseCode } = error as Record<string, unknown>;
  if (code === 'EAUTH' || code === 'ENOAUTH' || code === 'EOAUTH2') return { kind: 'authentication', retryable: false };
  if (['ECONFIG', 'ETLS', 'EREQUIRETLS', 'EFILEACCESS', 'EURLACCESS'].includes(String(code))) return { kind: 'configuration', retryable: false };
  // CONN alone is NOT evidence: Nodemailer also uses it for socket failures after DATA.
  if (command === 'CONN' && responseCode === undefined && (
    (code === 'ESOCKET' && originalCode === 'ECONNREFUSED') ||
    (code === 'EDNS' && originalCode === 'EAI_AGAIN') ||
    (code === 'ETIMEDOUT' && (timeoutType === 'CONNECT_TIMEOUT' || timeoutType === 'GREETING_TIMEOUT'))
  )) return { kind: 'connection-before-message', retryable: true };
  if (typeof responseCode === 'number' && Number.isInteger(responseCode)) {
    if (responseCode >= 400 && responseCode < 500) {
      const beforeData = (code === 'EENVELOPE' && (command === 'MAIL FROM' || command === 'RCPT TO')) ||
        ((code === 'EPROTOCOL' || code === 'ECONNECTION') && (command === 'EHLO' || command === 'HELO'));
      return { kind: 'temporary-rejection', retryable: beforeData };
    }
    if (responseCode >= 500 && responseCode < 600) return { kind: command === 'RCPT TO' ? 'recipient-rejected' : 'permanent-rejection', retryable: false };
  }
  // DATA, idle socket timeout/reset, incomplete responses and unknown errors never trigger retries.
  return { kind: 'uncertain', retryable: false };
}
