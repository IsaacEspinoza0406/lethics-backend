import { Db } from 'mongodb';

/** Read-only capability check: without this unique index a student could end up with two records per lesson. */
export async function hasLessonProgressUniqueness(db: Db): Promise<boolean> {
  const indexes = await db.collection('progreso_leccion').listIndexes().toArray();
  return indexes.some((i) => i.unique === true && i.hidden !== true && !i.sparse && !i.partialFilterExpression &&
    Object.keys(i.key).join(',') === 'usuarioId,leccionId' && i.key.usuarioId === 1 && i.key.leccionId === 1 && (!i.collation || i.collation.locale === 'simple'));
}
