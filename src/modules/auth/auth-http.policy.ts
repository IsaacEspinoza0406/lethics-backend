import { Inject, Injectable, ServiceUnavailableException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectConnection } from '@nestjs/mongoose';
import { Connection } from 'mongoose';
import { LimitedOperation } from '../../infrastructure/rate-limit/origin-rate-limit.service';
import { VERIFICATION_MAILER, VerificationMailer } from '../identity/application/verification-mailer';
import { SmtpVerificationMailer } from '../identity/infrastructure/smtp-verification-mailer';
import { inspectIdentityIndexes } from '../identity/infrastructure/identity-indexes';

@Injectable()
export class AuthHttpPolicy {
  constructor(private readonly config: ConfigService, @InjectConnection() private readonly connection: Connection,
    @Inject(VERIFICATION_MAILER) private readonly mailer: VerificationMailer) {}

  /** Configuration gating; infrastructure failures are checked for each accepted route invocation. */
  isEnabled(operation: LimitedOperation): boolean {
    if (this.config.get('AUTH_HTTP_ENABLED') !== true || this.config.get('AUTH_BEHIND_PROXY', false) !== false) return false;
    return operation === 'verify' || this.mailer instanceof SmtpVerificationMailer;
  }

  async assertReady(operation: LimitedOperation): Promise<void> {
    if (!this.isEnabled(operation)) throw new ServiceUnavailableException();
    try {
      if (this.connection.readyState !== 1 || !this.connection.db ||
          (await inspectIdentityIndexes(this.connection.db)).some((index) => index.status !== 'ready')) throw new Error('Precondiciones no satisfechas');
      if (operation !== 'verify') {
        if (!(this.mailer instanceof SmtpVerificationMailer)) throw new Error('Transporte no disponible');
        await this.mailer.assertAvailable();
      }
    } catch { throw new ServiceUnavailableException(); }
  }
}
