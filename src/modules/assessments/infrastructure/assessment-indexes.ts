import { Db } from 'mongodb';

/** Read-only capability check. A partial/sparse/hidden index cannot enforce this API contract. */
export async function hasAttemptUniqueness(db: Db): Promise<boolean> {
  const indexes = await db.collection('intentos_evaluacion').listIndexes().toArray();
  return indexes.some((i) => i.name === 'usuarioId_1_solicitudId_1' && i.unique === true && i.hidden !== true && !i.sparse && !i.partialFilterExpression &&
    Object.keys(i.key).join(',') === 'usuarioId,solicitudId' && i.key.usuarioId === 1 && i.key.solicitudId === 1 && (!i.collation || i.collation.locale === 'simple'));
}
