import { BadRequestException, ForbiddenException, HttpException, Injectable, NotFoundException, ServiceUnavailableException } from '@nestjs/common';
import { Types } from 'mongoose';
import { CourseModule, LessonBlock, OPERATIONAL_RESOURCES, Stored, unlockedModules } from '../domain/learning';
import { LearningContentService } from './learning-content.service';
import { ModuleProgressPort } from './module-progress';

/** Student-facing reads. Only published courses and active modules/lessons are ever visible. */
@Injectable()
export class LearningService {
  constructor(private readonly content: LearningContentService, private readonly progress: ModuleProgressPort) {}

  private async controlled<T>(action: () => Promise<T>): Promise<T> {
    try { return await action(); }
    catch (error) { if (error instanceof HttpException) throw error; throw new ServiceUnavailableException('Contenido educativo no disponible.'); }
  }
  private id(value: string): Types.ObjectId {
    if (typeof value !== 'string' || !/^[a-f\d]{24}$/i.test(value)) throw new BadRequestException('Identificador inválido.');
    return new Types.ObjectId(value);
  }
  /** Ids of the modules the student may open. Progress is consulted only when some module is not the first. */
  private async unlocked(userId: string, courseId: Types.ObjectId, modules: readonly Stored<CourseModule>[]): Promise<Set<string>> {
    let completed = new Set<string>();
    if (modules.some((m) => m.activo && m.orden > 1)) {
      const reported = await this.progress.completedModules(userId, courseId.toHexString());
      if (!Array.isArray(reported) || reported.some((value) => typeof value !== 'string' || !/^[a-f\d]{24}$/.test(value))) throw new Error('Contrato de progreso incompatible');
      completed = new Set(reported);
    }
    return unlockedModules(modules, completed);
  }
  /** Module that exists, is active, belongs to a published course and is open for this student. */
  private async openModule(userId: string, moduleId: Types.ObjectId): Promise<Stored<CourseModule>> {
    const module = await this.content.module(moduleId);
    if (!module?.activo || !(await this.content.publishedCourse(module.cursoId))) throw new NotFoundException('Módulo no disponible.');
    const open = await this.unlocked(userId, module.cursoId, await this.content.courseModules(module.cursoId));
    if (!open.has(module._id.toHexString())) throw new ForbiddenException('Completa el módulo anterior para acceder a este módulo.');
    return module;
  }
  private block(block: LessonBlock) {
    switch (block.tipo) {
      case 'lista': return { tipo: block.tipo, ordenada: block.ordenada, items: [...block.items] };
      case 'tabla': return { tipo: block.tipo, encabezados: [...block.encabezados], filas: block.filas.map((row) => [...row]) };
      case 'destacado': return { tipo: block.tipo, variante: block.variante, texto: block.texto };
      case 'recurso': return { tipo: block.tipo, recurso: block.recurso, operativo: OPERATIONAL_RESOURCES.has(block.recurso) };
      default: return { tipo: block.tipo, texto: block.texto };
    }
  }

  async courses(page: { pagina: number; limite: number }) {
    return this.controlled(async () => {
      const { items, hayMas } = await this.content.publishedCourses(page);
      return { items: items.map((c) => ({ id: c._id.toHexString(), titulo: c.titulo })), pagina: page.pagina, limite: page.limite, hayMas };
    });
  }
  async course(courseId: string) {
    return this.controlled(async () => {
      const course = await this.content.publishedCourse(this.id(courseId));
      if (!course) throw new NotFoundException('Curso no disponible.');
      const project = course.proyectoFinal;
      return { id: course._id.toHexString(), titulo: course.titulo,
        proyectoFinal: { instrucciones: project.instrucciones, requisitos: [...project.requisitos], formatosPermitidos: [...project.formatosPermitidos] } };
    });
  }
  async modules(userId: string, courseId: string) {
    return this.controlled(async () => {
      const cursoId = this.id(courseId);
      if (!(await this.content.publishedCourse(cursoId))) throw new NotFoundException('Curso no disponible.');
      const modules = await this.content.courseModules(cursoId), open = await this.unlocked(userId, cursoId, modules);
      return { cursoId: cursoId.toHexString(), items: modules.filter((m) => m.activo).map((m) => ({ id: m._id.toHexString(), orden: m.orden, titulo: m.titulo, disponible: open.has(m._id.toHexString()) })) };
    });
  }
  async lessons(userId: string, moduleId: string) {
    return this.controlled(async () => {
      const module = await this.openModule(userId, this.id(moduleId));
      const lessons = await this.content.activeLessons(module._id);
      return { moduloId: module._id.toHexString(), cursoId: module.cursoId.toHexString(), items: lessons.map((l) => ({ id: l._id.toHexString(), orden: l.orden, titulo: l.titulo, version: l.version })) };
    });
  }
  async lesson(userId: string, lessonId: string) {
    return this.controlled(async () => {
      const lesson = await this.content.activeLesson(this.id(lessonId));
      if (!lesson) throw new NotFoundException('Lección no disponible.');
      const module = await this.openModule(userId, lesson.moduloId);
      return { id: lesson._id.toHexString(), moduloId: module._id.toHexString(), cursoId: module.cursoId.toHexString(), orden: lesson.orden, titulo: lesson.titulo, version: lesson.version,
        secciones: lesson.secciones.map((b) => this.block(b)) };
    });
  }
}
