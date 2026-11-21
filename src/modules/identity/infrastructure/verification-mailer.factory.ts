import { ConfigService } from '@nestjs/config';
import { VerificationMailer } from '../application/verification-mailer';
import { DevelopmentVerificationMailer } from './development-verification-mailer';
import { TestVerificationMailer } from './test-verification-mailer';
import { SmtpVerificationMailer } from './smtp-verification-mailer';

export function verificationMailerFromConfig(config: ConfigService): VerificationMailer {
  const env = config.getOrThrow<string>('NODE_ENV');
  // Never connect to a real SMTP server during automated tests, even if inherited env contains SMTP settings.
  if (env === 'test') return new TestVerificationMailer();
  if (config.get('VERIFICATION_MAIL_TRANSPORT') === 'smtp') return new SmtpVerificationMailer(config);
  if (env === 'production') throw new Error('Proveedor de correo de producción no configurado');
  return new DevelopmentVerificationMailer();
}
