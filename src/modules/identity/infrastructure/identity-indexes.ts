import { Db, IndexDescriptionInfo } from 'mongodb';
import { isEmail } from 'class-validator';

export const identityIndexes = [
  { collection: 'usuarios', field: 'correo', name: 'correo_1' },
  { collection: 'tokens_cuenta', field: 'tokenHash', name: 'tokenHash_1' },
] as const;

export function compatibleIdentityIndex(index: IndexDescriptionInfo, field: string, name: string): boolean {
  return index.name === name && Object.keys(index.key).length === 1 && index.key[field] === 1 &&
    index.unique === true && index.hidden !== true && !index.sparse && !index.partialFilterExpression &&
    (!index.collation || index.collation.locale === 'simple') && index.expireAfterSeconds === undefined && !index.prepareUnique;
}

/** Only listIndexes; missing namespaces are reported, never created. */
export async function inspectIdentityIndexes(db: Db) {
  return Promise.all(identityIndexes.map(async (required) => {
    let indexes: IndexDescriptionInfo[];
    try { indexes = await db.collection(required.collection).listIndexes().toArray(); }
    catch (error) {
      if ((error as { code?: number }).code !== 26) throw error;
      return { ...required, status: 'missing-collection' as const };
    }
    const sameKey = indexes.filter((index) => Object.keys(index.key).length === 1 && index.key[required.field] === 1);
    const status = sameKey.some((index) => compatibleIdentityIndex(index, required.field, required.name)) ? 'ready' :
      sameKey.length || indexes.some((index) => index.name === required.name) ? 'incompatible' : 'missing';
    return { ...required, status, indexes: indexes.map(({ name, key, unique, sparse, partialFilterExpression, collation, hidden, expireAfterSeconds }) => ({ name, key, unique, sparse, partialFilterExpression, collation, hidden, expireAfterSeconds })) };
  }));
}

/** No values/identifiers are returned. JS normalization matches the application exactly. */
export async function inspectIdentityData(db: Db) {
  const reports = [];
  for (const required of identityIndexes) {
    const seen = new Set<string>();
    let invalid = 0, nonCanonical = 0, duplicates = 0;
    const cursor = db.collection(required.collection).find({}, { projection: { [required.field]: 1, _id: 0 } });
    try {
      for await (const document of cursor) {
        const value: unknown = document[required.field];
        if (typeof value !== 'string' || !value.trim() || (required.field === 'correo' && !isEmail(value.trim().toLowerCase()))) { invalid++; continue; }
        const normalized = required.field === 'correo' ? value.trim().toLowerCase() : value;
        if (value !== normalized) nonCanonical++;
        if (seen.has(normalized)) duplicates++;
        seen.add(normalized);
      }
    } finally { await cursor.close(); }
    reports.push({ collection: required.collection, invalid, nonCanonical, duplicates });
  }
  return reports;
}

/** Explicit operator action only. No syncIndexes, dropIndex, normalization or collection creation. */
export async function installIdentityIndexes(db: Db, confirmation: string): Promise<void> {
  if (confirmation !== `INSTALL INDEXES ${db.databaseName}`) throw new Error('Confirmación de índices requerida');
  const indexes = await inspectIdentityIndexes(db);
  const data = await inspectIdentityData(db);
  if (indexes.some((item) => ['missing-collection', 'incompatible'].includes(item.status)) || data.some((item) => item.invalid || item.nonCanonical || item.duplicates)) throw new Error('Precondiciones de índices no satisfechas');
  for (const required of identityIndexes) {
    await db.collection(required.collection).createIndex({ [required.field]: 1 }, { name: required.name, unique: true, collation: { locale: 'simple' } });
  }
  if ((await inspectIdentityIndexes(db)).some((item) => item.status !== 'ready')) throw new Error('Verificación posterior de índices fallida');
}
