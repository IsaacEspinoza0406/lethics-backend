import { ConfigService } from '@nestjs/config';
import { VerificationCodeService } from '../infrastructure/verification-code.service';

export interface VerificationPolicy { maxFailuresPerHour: number; maxEmissionsPerHour: number }
export const defaultVerificationPolicy: VerificationPolicy = { maxFailuresPerHour: 20, maxEmissionsPerHour: 5 };
export function verificationPolicyFromConfig(config: ConfigService): VerificationPolicy {
  return { maxFailuresPerHour: config.getOrThrow<number>('VERIFICATION_ACCOUNT_FAILURES_PER_HOUR'), maxEmissionsPerHour: config.getOrThrow<number>('VERIFICATION_ACCOUNT_EMISSIONS_PER_HOUR') };
}
export function verificationCodesFromConfig(config: ConfigService): VerificationCodeService {
  const key = config.getOrThrow<string>('VERIFICATION_CODE_HMAC_KEY_BASE64');
  const bytes = Buffer.from(key, 'base64');
  if (bytes.toString('base64') !== key) throw new Error('Clave de verificación inválida');
  return new VerificationCodeService(bytes, Buffer.from(config.getOrThrow<string>('JWT_ACCESS_SECRET_BASE64'), 'base64'));
}
