import { Injectable, ServiceUnavailableException } from '@nestjs/common';

export interface AssessmentContext {
  usuarioId: string;
  evaluacionId: string;
  cursoId: string;
  moduloId: string;
  version: number;
}
/** The owning course/progress modules must verify references and student availability. */
export abstract class AssessmentContextPort {
  abstract isAvailable(context: Readonly<AssessmentContext>): Promise<boolean>;
}
@Injectable()
export class UnintegratedAssessmentContext extends AssessmentContextPort {
  async isAvailable(): Promise<boolean> { throw new ServiceUnavailableException('Integración educativa pendiente.'); }
}
