import { Injectable, ServiceUnavailableException } from '@nestjs/common';

export interface AssessmentContext {
  usuarioId: string;
  evaluacionId: string;
  cursoId: string;
  moduloId: string;
  version: number;
}
export type FinalExamContext = Omit<AssessmentContext, 'moduloId'> & { moduloId: null };
/** The adapter supplies authoritative course-module IDs and registered valid submission evidence.
 * Missing/unavailable dependencies must throw, never fabricate a positive result. */
export interface FinalExamEligibility {
  cursoId: string;
  modulosCompletados: readonly string[];
  proyectoEntregado: boolean;
}
/** The owning course/progress modules must verify references and student availability. */
export abstract class AssessmentContextPort {
  abstract isAvailable(context: Readonly<AssessmentContext>): Promise<boolean>;
  // Concrete default preserves existing quiz adapters while keeping finals fail closed.
  async finalExamEligibility(context: Readonly<FinalExamContext>): Promise<FinalExamEligibility> {
    void context;
    throw new ServiceUnavailableException('Integración de progreso y entregas pendiente.');
  }
}
/** Trusted backend consumer; this is not an HTTP endpoint or a progress mutation. */
export interface QuizResult { moduloId: string; aprobado: boolean }
export abstract class AssessmentResultsPort {
  abstract hasPassedFinalExam(usuarioId: string, cursoId: string): Promise<boolean>;
  /** One entry per module with a complete, consistent quiz attempt, across historical versions.
   * Empty means no valid attempts; storage failures must throw, never masquerade as an empty list. */
  abstract quizResults(usuarioId: string, cursoId: string): Promise<QuizResult[]>;
}
@Injectable()
export class UnintegratedAssessmentContext extends AssessmentContextPort {
  async isAvailable(): Promise<boolean> { throw new ServiceUnavailableException('Integración educativa pendiente.'); }
}
