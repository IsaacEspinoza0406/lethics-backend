import { VerificationMailer } from '../application/verification-mailer';

/** Explicitly instantiated by tests only; never registered in the application. */
export class TestVerificationMailer implements VerificationMailer {
  private messages: Array<{ recipient: string; code: string }> = [];

  async sendVerification(recipient: string, code: string): Promise<void> {
    this.messages.push({ recipient, code });
  }

  takeMessages(): Array<{ recipient: string; code: string }> {
    const messages = this.messages;
    this.messages = [];
    return messages;
  }
}
