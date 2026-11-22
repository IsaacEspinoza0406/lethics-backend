import { Injectable, ServiceUnavailableException } from '@nestjs/common';
import { FileMetadata, ProjectPolicy } from '../domain/project';

export interface ProjectOwner { usuarioId: string; cursoId: string }
/** Values must come from approved course decisions, never defaults or the HTTP request. */
export interface CourseProject { cursoId: string; instrucciones: string; politica: ProjectPolicy }
export abstract class ProjectCoursePort {
  abstract describe(owner: Readonly<ProjectOwner>): Promise<CourseProject | null>;
}
export interface VerifiedProjectFile extends ProjectOwner, FileMetadata {
  referencia: string;
}
/** Only return files actually received, inspected and authorized for this user/course.
 * References must be durable, immutable and reusable by technical retries of that owner.
 * No client MIME/size, arbitrary URLs/paths or expiring signed URLs may establish proof. */
export abstract class ProjectFilePort {
  abstract verify(owner: Readonly<ProjectOwner>, referencia: string): Promise<VerifiedProjectFile | null>;
}
export abstract class ProjectSubmissionPort {
  abstract hasValidSubmission(usuarioId: string, cursoId: string): Promise<boolean>;
}
@Injectable()
export class UnintegratedProjectCourse extends ProjectCoursePort {
  async describe(owner: Readonly<ProjectOwner>): Promise<CourseProject | null> {
    void owner; throw new ServiceUnavailableException('Integración de cursos y política de proyecto pendiente.');
  }
}
@Injectable()
export class UnconfiguredProjectFiles extends ProjectFilePort {
  async verify(owner: Readonly<ProjectOwner>, referencia: string): Promise<VerifiedProjectFile | null> {
    void owner; void referencia; throw new ServiceUnavailableException('Almacenamiento de evidencias no configurado.');
  }
}
