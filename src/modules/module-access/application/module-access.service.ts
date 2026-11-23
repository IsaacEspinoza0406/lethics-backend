import { ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { Types } from 'mongoose';
import { LearningContentService } from '../../learning/application/learning-content.service';
import { CourseModule, Stored, unlockedModules } from '../../learning/domain/learning';
import { ModuleProgressPort } from './module-progress';

/**
 * Single place that decides whether a student may enter a module (sequential advance). Shared by every module
 * that serves module-scoped content (lessons, flashcards and, later, simulators). It throws HTTP exceptions for
 * "not available" (404) and "locked" (403); any other failure is left to the caller to sanitize as 503.
 */
@Injectable()
export class ModuleAccessService {
  constructor(private readonly content: LearningContentService, private readonly progress: ModuleProgressPort) {}

  /** Ids of the modules the student may open. Progress is consulted only when some active module is not the first. */
  async unlocked(userId: string, courseId: Types.ObjectId, modules: readonly Stored<CourseModule>[]): Promise<Set<string>> {
    let completed = new Set<string>();
    if (modules.some((m) => m.activo && m.orden > 1)) {
      const reported = await this.progress.completedModules(userId, courseId.toHexString());
      if (!Array.isArray(reported) || reported.some((value) => typeof value !== 'string' || !/^[a-f\d]{24}$/.test(value))) throw new Error('Contrato de progreso incompatible');
      completed = new Set(reported);
    }
    return unlockedModules(modules, completed);
  }

  /** Module that exists, is active, belongs to a published course and is open for this student. */
  async openModule(userId: string, moduleId: Types.ObjectId): Promise<Stored<CourseModule>> {
    const module = await this.content.module(moduleId);
    if (!module?.activo || !(await this.content.publishedCourse(module.cursoId))) throw new NotFoundException('Módulo no disponible.');
    const open = await this.unlocked(userId, module.cursoId, await this.content.courseModules(module.cursoId));
    if (!open.has(module._id.toHexString())) throw new ForbiddenException('Completa el módulo anterior para acceder a este módulo.');
    return module;
  }
}
