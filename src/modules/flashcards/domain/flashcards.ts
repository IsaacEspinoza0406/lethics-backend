import { Types } from 'mongoose';

/** Contract of the `flashcards` collection: a card belongs to a module and keeps its presentation order. */
export interface Flashcard { moduloId: Types.ObjectId; orden: number; concepto: string; definicion: string }
export type StoredFlashcard = Flashcard & { _id: Types.ObjectId };
export const MAX_CONCEPT_LENGTH = 300;
export const MAX_DEFINITION_LENGTH = 2000;

const isText = (value: unknown, max: number): value is string => typeof value === 'string' && value.length <= max && /\S/.test(value);
const isOrder = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 1 && value <= 2147483647;

/** Fail-closed check of a stored card: an incompatible document is never exposed. */
export function validFlashcard(value: unknown): value is StoredFlashcard {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const card = value as Record<string, unknown>;
  return card._id instanceof Types.ObjectId && card.moduloId instanceof Types.ObjectId && isOrder(card.orden) &&
    isText(card.concepto, MAX_CONCEPT_LENGTH) && isText(card.definicion, MAX_DEFINITION_LENGTH);
}
