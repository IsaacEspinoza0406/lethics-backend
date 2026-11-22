import { Types } from 'mongoose';
import { calculateGrade, Grade } from './grading';

export interface Question { id: string; texto: string; opciones: Array<{ id: string; texto: string }>; opcionCorrectaId: string }
export interface Answer { preguntaId: string; opcionId: string }
export interface Evaluation {
  cursoId: Types.ObjectId;
  moduloId: Types.ObjectId | null;
  tipo: 'cuestionario' | 'examen_final';
  version: number;
  minimoAprobatorio: number;
  estado: 'borrador' | 'publicado';
  preguntas: Question[];
}
export interface Attempt extends Grade {
  usuarioId: Types.ObjectId;
  evaluacionId: Types.ObjectId;
  cursoId: Types.ObjectId;
  moduloId: Types.ObjectId | null;
  version: number;
  solicitudId: string;
  respuestas: Answer[];
  fecha: Date;
}
const boundedText = (value: unknown, max: number): value is string => typeof value === 'string' && value.trim().length > 0 && value.length <= max;
export function validQuestions(questions: Question[]): boolean {
  return Array.isArray(questions) && questions.length >= 1 && questions.length <= 50 &&
    new Set(questions.map((q) => q?.id)).size === questions.length && questions.every((q) => q && boundedText(q.id, 128) && boundedText(q.texto, 4000) &&
      Array.isArray(q.opciones) && q.opciones.length >= 1 && q.opciones.length <= 6 && new Set(q.opciones.map((o) => o?.id)).size === q.opciones.length &&
      q.opciones.every((o) => o && boundedText(o.id, 128) && boundedText(o.texto, 2000)) && boundedText(q.opcionCorrectaId, 128) && q.opciones.some((o) => o.id === q.opcionCorrectaId));
}
export function validEvaluation(value: Evaluation): boolean {
  return Boolean(value && value.cursoId instanceof Types.ObjectId && (value.tipo === 'cuestionario' ? value.moduloId instanceof Types.ObjectId : value.tipo === 'examen_final' && value.moduloId === null) &&
    Number.isSafeInteger(value.version) && value.version >= 1 && value.version <= 2147483647 && value.minimoAprobatorio === 70 &&
    ['borrador', 'publicado'].includes(value.estado) && validQuestions(value.preguntas));
}
export class InvalidAnswersError extends Error { constructor() { super('Respuestas de evaluación inválidas.'); } }
export function normalizeAnswers(answers: Answer[]): Answer[] {
  if (!Array.isArray(answers) || answers.length < 1 || answers.length > 50 || !answers.every((a) => a && boundedText(a.preguntaId, 128) && boundedText(a.opcionId, 128)) ||
    new Set(answers.map((a) => a.preguntaId)).size !== answers.length) throw new InvalidAnswersError();
  return answers.map((a) => ({ preguntaId: a.preguntaId, opcionId: a.opcionId })).sort((a, b) => a.preguntaId < b.preguntaId ? -1 : a.preguntaId > b.preguntaId ? 1 : 0);
}
export function gradeAnswers(questions: Question[], answers: Answer[]): Grade {
  if (!validQuestions(questions)) throw new TypeError('Contenido de evaluación inválido');
  const normalized = normalizeAnswers(answers), supplied = new Map(normalized.map((a) => [a.preguntaId, a.opcionId]));
  if (normalized.length !== questions.length || questions.some((q) => !q.opciones.some((o) => o.id === supplied.get(q.id)))) throw new InvalidAnswersError();
  return calculateGrade(questions.filter((q) => supplied.get(q.id) === q.opcionCorrectaId).length, questions.length);
}
