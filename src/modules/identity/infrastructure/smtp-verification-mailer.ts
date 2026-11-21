import { ConfigService } from '@nestjs/config';
import { OnApplicationShutdown } from '@nestjs/common';
import { createTransport, SendMailOptions } from 'nodemailer';
import { isEmail } from 'class-validator';
import { randomUUID } from 'node:crypto';
import { VerificationDeliveryError, VerificationMailer } from '../application/verification-mailer';
import { classifySmtpFailure, smtpDeliveryPolicy } from './smtp-delivery-policy';

export interface VerificationSmtpTransport {
  verify(): Promise<boolean>;
  sendMail(message: SendMailOptions): Promise<{ accepted: unknown[]; rejected: unknown[] }>;
  close(): void;
}

/** Provider-neutral SMTP. No pool, file/URL content, protocol logs or insecure TLS fallback. */
export class SmtpVerificationMailer implements VerificationMailer, OnApplicationShutdown {
  private readonly transport: VerificationSmtpTransport;
  private readonly from: string;
  private stopped = false;

  constructor(config: ConfigService) {
    const host = config.getOrThrow<string>('SMTP_HOST');
    const port = config.getOrThrow<number>('SMTP_PORT');
    const secure = config.getOrThrow<boolean>('SMTP_SECURE');
    const user = config.getOrThrow<string>('SMTP_USER');
    const pass = config.getOrThrow<string>('SMTP_PASSWORD');
    this.from = config.getOrThrow<string>('SMTP_FROM');
    if (!host || /[\s/:]/.test(host) || !Number.isInteger(port) || port < 1 || port > 65535 || typeof secure !== 'boolean' || !user || !pass || !isEmail(this.from) || /[\r\n]/.test(this.from)) throw new Error('Configuración SMTP inválida');
    this.transport = createTransport({
      host, port, secure, requireTLS: !secure,
      auth: { user, pass }, tls: { rejectUnauthorized: true, minVersion: 'TLSv1.2' },
      connectionTimeout: 5000, greetingTimeout: 5000, socketTimeout: 10000, dnsTimeout: 5000,
      pool: false, logger: false, debug: false, disableFileAccess: true, disableUrlAccess: true,
    });
  }

  /** Checks connection/TLS/authentication, not delivery or ownership of a recipient. */
  async assertAvailable(): Promise<void> {
    try { if (this.stopped || await this.transport.verify() !== true) throw new Error('Transporte no disponible'); }
    catch { throw new VerificationDeliveryError(); }
  }

  async sendVerification(recipient: string, code: string): Promise<void> {
    try {
      if (!isEmail(recipient) || /[\r\n]/.test(recipient) || !/^[0-9]{6}$/.test(code)) throw new Error('Mensaje inválido');
      // Stable within this invocation only. Message-ID does not provide SMTP deduplication.
      const message: SendMailOptions = { from: this.from, to: recipient, date: new Date(),
        messageId: `<${randomUUID()}@${this.from.split('@')[1]}>`,
        subject: 'Verificación de correo — Lethics', text: `Tu código de verificación es ${code}. Vence en cinco minutos. Si no solicitaste este código, ignora este mensaje.` };
      const started = performance.now();
      for (let attempt = 1; attempt <= smtpDeliveryPolicy.maxAttempts; attempt++) {
        if (this.stopped) throw new VerificationDeliveryError();
        try {
          const result = await this.transport.sendMail({ ...message });
          if (result.rejected.length || !result.accepted.some((value) => typeof value === 'string' && value.toLowerCase() === recipient.toLowerCase())) throw new VerificationDeliveryError();
          return; // Accepted by SMTP; no assertion about inbox delivery or reading.
        } catch (error) {
          if (!classifySmtpFailure(error).retryable || attempt === smtpDeliveryPolicy.maxAttempts ||
              performance.now() - started + smtpDeliveryPolicy.retryDelayMs >= smtpDeliveryPolicy.retryWindowMs) throw new VerificationDeliveryError();
          await new Promise<void>((done) => setTimeout(done, smtpDeliveryPolicy.retryDelayMs));
          if (performance.now() - started >= smtpDeliveryPolicy.retryWindowMs) throw new VerificationDeliveryError();
        }
      }
    } catch { throw new VerificationDeliveryError(); }
  }

  onApplicationShutdown(): void { this.stopped = true; this.transport.close(); }
}
