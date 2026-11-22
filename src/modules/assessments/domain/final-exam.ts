import { createHash } from 'node:crypto';
import { Types } from 'mongoose';

export const FINAL_EXAM_ATTEMPTS = 3;
/** Reuses the approved ObjectId primary key as a bounded insertion slot, across versions.
 * It is an identifier, never a credential. Collisions fail closed; no updates or deletion. */
export function finalAttemptId(usuarioId: Types.ObjectId, cursoId: Types.ObjectId, ordinal: number): Types.ObjectId {
  if (!Number.isSafeInteger(ordinal) || ordinal < 1 || ordinal > FINAL_EXAM_ATTEMPTS) throw new RangeError('Cupo inválido');
  return new Types.ObjectId(createHash('sha256').update(`lethics:final-attempt:v1:${usuarioId.toHexString()}:${cursoId.toHexString()}:${ordinal}`).digest().subarray(0, 12));
}
