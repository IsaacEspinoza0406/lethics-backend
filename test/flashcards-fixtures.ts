import { Types } from 'mongoose';
import { Flashcard, StoredFlashcard } from '../src/modules/flashcards/domain/flashcards';

/** Synthetic cards only: not the private academic material. */
export const cardFixture = (moduloId: Types.ObjectId, orden: number, overrides: Partial<Flashcard> = {}): StoredFlashcard =>
  ({ _id: new Types.ObjectId(), moduloId, orden, concepto: `Concepto sintético ${orden}`, definicion: `Definición sintética ${orden}.`, ...overrides });
