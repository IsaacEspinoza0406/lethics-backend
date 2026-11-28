import { BadRequestException, ConflictException, HttpException, Injectable, NotFoundException, ServiceUnavailableException } from '@nestjs/common';
import { Types } from 'mongoose';
import { LearningContentService } from '../../learning/application/learning-content.service';
import { Lesson, Stored } from '../../learning/domain/learning';
import { ModuleAccessService } from '../../module-access/application/module-access.service';
import { LessonProgress, requiredActivity } from '../domain/lesson-progress';
import { LessonProgressStore, ProgressKey } from '../infrastructure/lesson-progress.store';

/**
 * Lesson progress of the authenticated student. The student id always comes from the access token, and every
 * operation first checks that the lesson is visible and its module open for that student.
 */
@Injectable()
export class LessonProgressService {
  constructor(private readonly store: LessonProgressStore,
    private readonly content: LearningContentService, private readonly access: ModuleAccessService) {}

  private async controlled<T>(action: () => Promise<T>): Promise<T> {
    try { return await action(); }
    catch (error) { if (error instanceof HttpException) throw error; throw new ServiceUnavailableException('Progreso no disponible.'); }
  }
  private id(value: string): Types.ObjectId {
    if (typeof value !== 'string' || !/^[a-f\d]{24}$/i.test(value)) throw new BadRequestException('Identificador inválido.');
    return new Types.ObjectId(value);
  }
  private async openLesson(userId: string, lessonId: string): Promise<Stored<Lesson>> {
    const lesson = await this.content.activeLesson(this.id(lessonId));
    if (!lesson) throw new NotFoundException('Lección no disponible.');
    await this.access.openModule(userId, lesson.moduloId);
    return lesson;
  }
  private view(leccionId: Types.ObjectId, record: LessonProgress | undefined) {
    return {
      leccionId: leccionId.toHexString(),
      estado: record?.estado ?? ('no_iniciada' as const),
      puntoActual: record?.puntoActual ?? null,
      actualizadoEn: record?.actualizadoEn.toISOString() ?? null,
      completadaEn: record?.completadaEn?.toISOString() ?? null,
    };
  }
  private async read(key: ProgressKey) {
    return this.view(key.leccionId, await this.store.get(key));
  }

  /** Saves the reading position. It never changes the state of a completed lesson. */
  async save(userId: string, lessonId: string, puntoActual: number) {
    return this.controlled(async () => {
      const usuarioId = this.id(userId), lesson = await this.openLesson(userId, lessonId);
      if (puntoActual >= lesson.secciones.length) throw new BadRequestException('La posición no existe en esta lección.');
      await this.store.assertStorage(true);
      const key = { usuarioId, leccionId: lesson._id };
      await this.store.savePosition(key, puntoActual);
      return this.read(key);
    });
  }

  /** Marks a reading lesson as completed. Repeating it keeps the original completion date. */
  async complete(userId: string, lessonId: string) {
    return this.controlled(async () => {
      const usuarioId = this.id(userId), lesson = await this.openLesson(userId, lessonId);
      const activity = requiredActivity(lesson.secciones);
      if (activity) throw new ConflictException(`Esta lección se completa al enviar el ${activity}.`);
      await this.store.assertStorage(true);
      const key = { usuarioId, leccionId: lesson._id };
      await this.store.markCompleted(key, lesson.secciones.length - 1);
      return this.read(key);
    });
  }

  /** The student's progress in every active lesson of an open module, in lesson order. */
  async moduleProgress(userId: string, moduleId: string) {
    return this.controlled(async () => {
      const usuarioId = this.id(userId), module = await this.access.openModule(userId, this.id(moduleId));
      const lessons = await this.content.activeLessons(module._id);
      await this.store.assertStorage(false);
      const found = await this.store.find(usuarioId, lessons.map((l) => l._id));
      const byLesson = new Map(found.map((record) => [record.leccionId.toHexString(), record]));
      return { moduloId: module._id.toHexString(), cursoId: module.cursoId.toHexString(),
        items: lessons.map((l) => ({ orden: l.orden, ...this.view(l._id, byLesson.get(l._id.toHexString())) })) };
    });
  }
}
