import { Db, MongoClient } from 'mongodb';
import { Types } from 'mongoose';

export function validVerificationState(value: unknown): boolean {
  if (!value || typeof value !== 'object') return false;
  const state = value as Record<string, unknown>;
  return state.tokenActualId instanceof Types.ObjectId &&
    ['ultimaEmision', 'emisionesInicio', 'fallosInicio'].every((key) => state[key] instanceof Date && Number.isFinite((state[key] as Date).getTime())) &&
    ['emisiones', 'fallos', 'revision'].every((key) => Number.isSafeInteger(state[key]) && (state[key] as number) >= 0);
}

export function validVerificationToken(value: unknown): boolean {
  if (!value || typeof value !== 'object') return false;
  const token = value as Record<string, unknown>;
  return token.versionHmac === 2 && Number.isSafeInteger(token.intentosFallidos) &&
    (token.intentosFallidos as number) >= 0 && (token.intentosFallidos as number) <= 5;
}

/** Inventory only: never returns emails, hashes, codes or IDs. */
export async function inspectLegacySecurity(db: Db) {
  let blockedUsers = 0, unsafeActiveTokens = 0;
  for await (const user of db.collection('usuarios').find({}, { projection: { seguridadVerificacion: 1, verificadoEn: 1 } })) {
    const verified = user.verificadoEn instanceof Date && Number.isFinite(user.verificadoEn.getTime());
    if (!verified && !validVerificationState(user.seguridadVerificacion)) blockedUsers++;
  }
  for await (const token of db.collection('tokens_cuenta').find({ tipo: 'verificacion', usadoEn: null, revocadoEn: null }, { projection: { usuarioId: 1, versionHmac: 1, intentosFallidos: 1 } })) {
    const user = await db.collection('usuarios').findOne({ _id: token.usuarioId }, { projection: { seguridadVerificacion: 1 } });
    if (!validVerificationToken(token) || !validVerificationState(user?.seguridadVerificacion)) unsafeActiveTokens++;
  }
  return { blockedUsers, unsafeActiveTokens };
}

/** Rehearsal only until the team approves real-data recovery. Existing quotas/state stay untouched. */
export async function quarantineLegacyVerification(client: MongoClient, db: Db, confirmation: string, now = new Date()) {
  if (!/^lethics_ops_test_[a-f0-9]{32}$/.test(db.databaseName) || confirmation !== `QUARANTINE ${db.databaseName}` || !Number.isFinite(now.getTime())) throw new Error('Migración permitida únicamente en base temporal confirmada');
  const session = client.startSession();
  try {
    return await session.withTransaction(async () => {
      let revoked = 0;
      for await (const token of db.collection('tokens_cuenta').find({ tipo: 'verificacion', usadoEn: null, revocadoEn: null }, { session })) {
        const user = await db.collection('usuarios').findOne({ _id: token.usuarioId }, { session });
        if (validVerificationToken(token) && validVerificationState(user?.seguridadVerificacion)) continue;
        const result = await db.collection('tokens_cuenta').updateOne({ _id: token._id, usadoEn: null, revocadoEn: null }, { $set: { revocadoEn: now } }, { session });
        revoked += result.modifiedCount;
      }
      return { revoked };
    });
  } finally { await session.endSession(); }
}
