import { Injectable, ServiceUnavailableException } from '@nestjs/common';
import { ProjectSubmissionPort } from '../../projects/application/project-ports';
import { AssessmentContext, AssessmentContextPort, FinalExamContext, FinalExamEligibility } from './assessment-context';

/** Course/progress owning module must bind a read-only authoritative adapter. */
export abstract class AssessmentProgressPort {
  abstract isQuizAvailable(context: Readonly<AssessmentContext>): Promise<boolean>;
  abstract completedModules(context: Readonly<FinalExamContext>): Promise<{ cursoId: string; modulosCompletados: readonly string[] }>;
}
@Injectable()
export class UnintegratedAssessmentProgress extends AssessmentProgressPort {
  async isQuizAvailable(context: Readonly<AssessmentContext>): Promise<boolean> { void context; throw new ServiceUnavailableException('Integración educativa pendiente.'); }
  async completedModules(context: Readonly<FinalExamContext>): Promise<{ cursoId: string; modulosCompletados: readonly string[] }> { void context; throw new ServiceUnavailableException('Integración de progreso pendiente.'); }
}
/** Composes real project lookup with the progress contract, without accessing its models. */
@Injectable()
export class ProjectAssessmentContext extends AssessmentContextPort {
  constructor(private readonly progress: AssessmentProgressPort, private readonly projects: ProjectSubmissionPort) { super(); }
  isAvailable(context: Readonly<AssessmentContext>): Promise<boolean> { return this.progress.isQuizAvailable(context); }
  async finalExamEligibility(context: Readonly<FinalExamContext>): Promise<FinalExamEligibility> {
    const progress = await this.progress.completedModules(context);
    return { ...progress, proyectoEntregado: await this.projects.hasValidSubmission(context.usuarioId, context.cursoId) };
  }
}
