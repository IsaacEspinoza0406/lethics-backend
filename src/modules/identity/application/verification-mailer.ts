/** A future provider must not log, expose, or persist the code in plaintext. */
export interface VerificationMailer {
  sendVerification(recipient: string, code: string): Promise<void>;
}

export const VERIFICATION_MAILER = Symbol('VERIFICATION_MAILER');

/** Delivery failed after the identity transaction; do not disclose account existence over HTTP. */
export class VerificationDeliveryError extends Error {
  constructor() { super('No se pudo procesar el envío'); }
}

export class VerificationStateUnavailableError extends Error {
  constructor() { super('Estado de verificación requiere migración'); }
}
