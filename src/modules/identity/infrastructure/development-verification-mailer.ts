import { VerificationMailer } from '../application/verification-mailer';

/** Local non-delivery adapter. Never logs or retains verification codes. */
export class DevelopmentVerificationMailer implements VerificationMailer {
  async sendVerification(): Promise<void> { /* No external delivery. */ }
}
