/** A future provider must not log, expose, or persist the code in plaintext. */
export interface VerificationMailer {
  sendVerification(recipient: string, code: string): Promise<void>;
}

export const VERIFICATION_MAILER = Symbol('VERIFICATION_MAILER');
