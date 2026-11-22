import { Types } from 'mongoose';
import { Answer, Evaluation } from '../src/modules/assessments/domain/assessment';

export function assessmentFixture(overrides: Partial<Evaluation> = {}): Evaluation {
  return { cursoId: new Types.ObjectId(), moduloId: new Types.ObjectId(), tipo: 'cuestionario', version: 1, minimoAprobatorio: 70, estado: 'publicado',
    preguntas: Array.from({ length: 10 }, (_, i) => ({ id: `q${i + 1}`, texto: `Pregunta sintética ${i + 1}`, opciones: [{ id: 'a', texto: 'Opción sintética A' }, { id: 'b', texto: 'Opción sintética B' }], opcionCorrectaId: 'a' })), ...overrides };
}
export function assessmentAnswers(correct = 7): Answer[] {
  return Array.from({ length: 10 }, (_, i) => ({ preguntaId: `q${i + 1}`, opcionId: i < correct ? 'a' : 'b' }));
}
