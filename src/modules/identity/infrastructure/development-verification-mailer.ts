import { VerificationMailer } from '../application/verification-mailer';

/** Disabled transport: never simulate successful delivery outside tests. */
export class DevelopmentVerificationMailer implements VerificationMailer {
  async sendPasswordRecovery(): Promise<void> { throw new Error('Transporte de correo no configurado'); }
  async sendVerification(): Promise<void> { throw new Error('Transporte de correo no configurado'); }
}
