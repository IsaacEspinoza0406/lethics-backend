import { Types } from 'mongoose';
import { Stored } from '../../learning/domain/learning';

/** Contract of `simuladores` (content) and `respuestas_simulador` (student answers). */
export const SIMULATOR_MODES = ['guiado', 'ia_asistida'] as const;
export const AI_STATES = ['pendiente_ia', 'evaluada', 'error_ia'] as const;
export const MAX_DECISION_LENGTH = 5000;

export interface Simulator {
  moduloId: Types.ObjectId;
  titulo: string;
  version: number;
  contexto: string;
  consigna: string;
  modo: (typeof SIMULATOR_MODES)[number];
  activo: boolean;
}
export interface SimulatorResponse {
  usuarioId: Types.ObjectId;
  simuladorId: Types.ObjectId;
  cursoId: Types.ObjectId;
  moduloId: Types.ObjectId;
  /** Version of the case the student answered. */
  version: number;
  decision: string;
  fecha: Date;
  estadoIA: (typeof AI_STATES)[number];
}

const isText = (value: unknown, max: number): value is string => typeof value === 'string' && value.length <= max && /\S/.test(value);
const isVersion = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 1 && value <= 2147483647;
const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);

export function validSimulator(value: unknown): value is Stored<Simulator> {
  return isRecord(value) && value._id instanceof Types.ObjectId && value.moduloId instanceof Types.ObjectId && isText(value.titulo, 300) &&
    isVersion(value.version) && isText(value.contexto, 20000) && isText(value.consigna, 4000) && SIMULATOR_MODES.includes(value.modo as never) &&
    typeof value.activo === 'boolean';
}
export function validSimulatorResponse(value: unknown): value is Stored<SimulatorResponse> {
  return isRecord(value) && [value._id, value.usuarioId, value.simuladorId, value.cursoId, value.moduloId].every((id) => id instanceof Types.ObjectId) &&
    isVersion(value.version) && isText(value.decision, MAX_DECISION_LENGTH) && value.fecha instanceof Date && Number.isFinite(value.fecha.getTime()) &&
    AI_STATES.includes(value.estadoIA as never);
}
