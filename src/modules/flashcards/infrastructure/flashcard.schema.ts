import { Schema, SchemaDefinitionProperty, SchemaTypeOptions } from 'mongoose';
import { Flashcard, MAX_CONCEPT_LENGTH, MAX_DEFINITION_LENGTH } from '../domain/flashcards';

// Mongoose 8's number declarations omit Int32 although it works at runtime; same boundary assertion as the other schemas.
const int32 = (options: SchemaTypeOptions<number>): SchemaDefinitionProperty<number> => ({ ...options, type: Schema.Types.Int32 }) as unknown as SchemaDefinitionProperty<number>;
const text = (max: number) => ({ type: String, required: true, maxlength: max, match: /\S/ });

// No index is declared: the approved model has none for `flashcards` (about 50 documents in total).
// Reads sort by `orden` then `_id`; uniqueness of (moduloId, orden) is guaranteed by the content loader.
export const FlashcardSchema = new Schema<Flashcard>({
  moduloId: { type: Schema.Types.ObjectId, ref: 'Modulo', required: true },
  orden: int32({ required: true, min: 1 }),
  concepto: text(MAX_CONCEPT_LENGTH),
  definicion: text(MAX_DEFINITION_LENGTH),
}, { collection: 'flashcards', autoCreate: false, autoIndex: false, versionKey: false, strict: 'throw' });
