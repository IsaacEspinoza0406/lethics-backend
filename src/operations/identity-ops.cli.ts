import { existsSync } from 'node:fs';
import { createInterface } from 'node:readline/promises';
import { MongoClient } from 'mongodb';
import { environmentSchema } from '../config/environment';
import { inspectIdentityData, inspectIdentityIndexes, installIdentityIndexes } from '../modules/identity/infrastructure/identity-indexes';
import { inspectLegacySecurity } from '../modules/identity/infrastructure/legacy-security';
import { createClient } from 'redis';
import { inspectRedisReadiness } from '../infrastructure/rate-limit/redis-readiness';

async function main(): Promise<void> {
  if (existsSync('.env')) process.loadEnvFile('.env');
  const command = process.argv[2];
  if (command === 'config') {
    const { error } = environmentSchema.validate(process.env, { abortEarly: false });
    console.log(JSON.stringify({ configurationValid: !error, invalidFields: error?.details.map((item) => item.path.join('.')) ?? [], publicEndpointsEnabled: false }));
    if (error) process.exitCode = 1;
    return;
  }
  if (command === 'redis') {
    const { error, value } = environmentSchema.validate(process.env);
    if (error) throw new Error('Configuración inválida');
    const redis = createClient({ url: value.REDIS_URL, socket: { connectTimeout: 2000, reconnectStrategy: false }, disableOfflineQueue: true });
    redis.on('error', () => undefined);
    try {
      await redis.connect();
      const maxWindow = Math.max(value.RATE_LIMIT_VERIFY_WINDOW_SECONDS, value.RATE_LIMIT_REGISTER_WINDOW_SECONDS, value.RATE_LIMIT_RESEND_WINDOW_SECONDS);
      const result = inspectRedisReadiness(await redis.info('server'), await redis.info('persistence'), await redis.info('replication'), await redis.sendCommand(['CONFIG', 'GET', 'appendonly', 'appendfsync', 'maxmemory-policy']), maxWindow);
      const after = await redis.info('server');
      if (!result.runId || !after.includes(`run_id:${result.runId}\r\n`)) throw new Error('Redis cambió durante la comprobación');
      console.log(JSON.stringify({ ready: result.ready, reason: result.reason, quarantineRemainingSeconds: result.quarantineRemainingSeconds }));
      if (!result.ready) process.exitCode = 1;
    } finally { if (redis.isOpen) await redis.close(); }
    return;
  }
  if (!['check', 'install-indexes'].includes(command)) throw new Error('Comando inválido');
  const uri = process.env.MONGODB_URI;
  if (!uri) throw new Error('Configuración ausente');
  const client = new MongoClient(uri, { serverSelectionTimeoutMS: 5000, readPreference: 'primary' });
  try {
    await client.connect();
    const db = client.db();
    const indexes = await inspectIdentityIndexes(db);
    const data = await inspectIdentityData(db);
    const legacy = await inspectLegacySecurity(db);
    console.log(JSON.stringify({ database: db.databaseName, indexes, data, legacy }));
    if (command === 'check') {
      if (indexes.some((item) => item.status !== 'ready') || data.some((item) => item.invalid || item.nonCanonical || item.duplicates) || legacy.blockedUsers || legacy.unsafeActiveTokens) process.exitCode = 1;
      return;
    }
    if (!process.stdin.isTTY || !process.stdout.isTTY) throw new Error('Se requiere operador interactivo');
    const prompt = createInterface({ input: process.stdin, output: process.stdout });
    try {
      const confirmed = await prompt.question(`Con escritores detenidos, respaldo verificado y autorización, escriba INSTALL INDEXES ${db.databaseName}: `);
      await installIdentityIndexes(db, confirmed);
      console.log('Índices verificados');
    } finally { prompt.close(); }
  } finally { await client.close(); }
}

void main().catch(() => { console.error('Comprobación fallida; revise destino, permisos, precondiciones y disponibilidad. No se muestran detalles sensibles.'); process.exitCode = 1; });
