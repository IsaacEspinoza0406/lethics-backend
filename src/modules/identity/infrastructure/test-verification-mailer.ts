import { VerificationMailer } from '../application/verification-mailer';

/** Explicitly instantiated by tests only; never registered in the application. */
export class TestVerificationMailer implements VerificationMailer {
  private messages: Array<{ recipient: string; code: string }> = [];
  private recoveryMessages: Array<{ recipient: string; token: string; expiresInMinutes: number }> = [];

  async sendPasswordRecovery(recipient: string, token: string, expiresInMinutes: number): Promise<void> { this.recoveryMessages.push({ recipient, token, expiresInMinutes }); }
  takeRecoveryMessages(): Array<{ recipient: string; token: string; expiresInMinutes: number }> {
    const messages = this.recoveryMessages; this.recoveryMessages = []; return messages;
  }

  async sendVerification(recipient: string, code: string): Promise<void> {
    this.messages.push({ recipient, code });
  }

  takeMessages(): Array<{ recipient: string; code: string }> {
    const messages = this.messages;
    this.messages = [];
    return messages;
  }
}
