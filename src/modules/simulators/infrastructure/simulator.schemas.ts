import { Schema, SchemaDefinitionProperty } from 'mongoose';
import { AI_STATES, MAX_DECISION_LENGTH, SIMULATOR_MODES, Simulator, SimulatorResponse } from '../domain/simulator';

// Same Int32 boundary assertion as the content schemas: Mongoose 8 declarations omit it although it works.
const version = { type: Schema.Types.Int32, required: true, min: 1 } as unknown as SchemaDefinitionProperty<number>;
const reference = (ref: string) => ({ type: Schema.Types.ObjectId, ref, required: true as const });
const text = (max: number) => ({ type: String, required: true, maxlength: max, match: /\S/ });
const options = (collection: string) => ({ collection, autoCreate: false as const, autoIndex: false as const, versionKey: false as const, strict: 'throw' as const });

// No index is approved for these two collections yet, so none is declared.
export const SimulatorSchema = new Schema<Simulator>({
  moduloId: reference('Modulo'),
  titulo: text(300),
  version,
  contexto: text(20000),
  consigna: text(4000),
  modo: { type: String, required: true, enum: [...SIMULATOR_MODES] },
  activo: { type: Boolean, required: true },
}, options('simuladores'));

export const SimulatorResponseSchema = new Schema<SimulatorResponse>({
  usuarioId: reference('Usuario'),
  simuladorId: reference('Simulador'),
  cursoId: reference('Curso'),
  moduloId: reference('Modulo'),
  version,
  decision: text(MAX_DECISION_LENGTH),
  fecha: { type: Date, required: true },
  estadoIA: { type: String, required: true, enum: [...AI_STATES] },
}, options('respuestas_simulador'));
