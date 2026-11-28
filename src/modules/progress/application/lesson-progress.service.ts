import { BadRequestException, ConflictException, HttpException, Injectable, NotFoundException, ServiceUnavailableException } from '@nestjs/common';
import { InjectConnection, InjectModel } from '@nestjs/mongoose';
import { Connection, Model, Types, UpdateQuery } from 'mongoose';
import { LearningContentService } from '../../learning/application/learning-content.service';
import { Lesson, Stored } from '../../learning/domain/learning';
import { ModuleAccessService } from '../../module-access/application/module-access.service';
import { LessonProgress, requiredActivity, validLessonProgress } from '../domain/lesson-progress';
import { hasLessonProgressUniqueness } from '../infrastructure/lesson-progress-indexes';

type Key = { usuarioId: Types.ObjectId; leccionId: Types.ObjectId };

/**
 * Lesson progress of the authenticated student. The student id always comes from the access token, and every
 * operation first checks that the lesson is visible and its module open for that student.
 */
@Injectable()
export class LessonProgressService {
  constructor(@InjectConnection() private readonly connection: Connection,
    @InjectModel('ProgresoLeccion') private readonly records: Model<LessonProgress>,
    private readonly content: LearningContentService, private readonly access: ModuleAccessService) {}

  private async controlled<T>(action: () => Promise<T>): Promise<T> {
    try { return await action(); }
    catch (error) { if (error instanceof HttpException) throw error; throw new ServiceUnavailableException('Progreso no disponible.'); }
  }
  private id(value: string): Types.ObjectId {
    if (typeof value !== 'string' || !/^[a-f\d]{24}$/i.test(value)) throw new BadRequestException('Identificador inválido.');
    return new Types.ObjectId(value);
  }
  /** An unprepared storage must fail, never look like a student without progress. */
  private async storage(write: boolean): Promise<void> {
    if (this.connection.readyState !== 1 || !this.connection.db) throw new Error('Sin conexión');
    const names = await this.connection.db.listCollections({ name: 'progreso_leccion' }, { nameOnly: true }).toArray();
    if (names.length !== 1 || (write && !(await hasLessonProgressUniqueness(this.connection.db)))) throw new Error('Almacenamiento sin preparar');
  }
  private async openLesson(userId: string, lessonId: string): Promise<Stored<Lesson>> {
    const lesson = await this.content.activeLesson(this.id(lessonId));
    if (!lesson) throw new NotFoundException('Lección no disponible.');
    await this.access.openModule(userId, lesson.moduloId);
    return lesson;
  }
  private checked(record: unknown) {
    if (!validLessonProgress(record)) throw new Error('Progreso incompatible');
    return record;
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
  private async read(key: Key) {
    return this.view(key.leccionId, this.checked(await this.records.findOne(key).lean()));
  }
  /** Concurrent first writes can both try to insert; the unique index rejects one, which then updates. */
  private async upsert(key: Key, update: UpdateQuery<LessonProgress>): Promise<void> {
    const write = () => this.records.updateOne(key, update, { upsert: true, runValidators: true });
    try { await write(); }
    catch (error) { if ((error as { code?: unknown }).code !== 11000) throw error; await write(); }
  }

  /** Saves the reading position. It never changes the state of a completed lesson. */
  async save(userId: string, lessonId: string, puntoActual: number) {
    return this.controlled(async () => {
      const usuarioId = this.id(userId), lesson = await this.openLesson(userId, lessonId);
      if (puntoActual >= lesson.secciones.length) throw new BadRequestException('La posición no existe en esta lección.');
      await this.storage(true);
      const key = { usuarioId, leccionId: lesson._id };
      await this.upsert(key, { $set: { puntoActual, actualizadoEn: new Date() }, $setOnInsert: { estado: 'en_progreso', completadaEn: null } });
      return this.read(key);
    });
  }

  /** Marks a reading lesson as completed. Repeating it keeps the original completion date. */
  async complete(userId: string, lessonId: string) {
    return this.controlled(async () => {
      const usuarioId = this.id(userId), lesson = await this.openLesson(userId, lessonId);
      const activity = requiredActivity(lesson.secciones);
      if (activity) throw new ConflictException(`Esta lección se completa al enviar el ${activity}.`);
      await this.storage(true);
      const key = { usuarioId, leccionId: lesson._id }, now = new Date();
      await this.upsert(key, { $setOnInsert: { estado: 'completada', puntoActual: lesson.secciones.length - 1, actualizadoEn: now, completadaEn: now } });
      await this.records.updateOne({ ...key, estado: 'en_progreso' }, { $set: { estado: 'completada', actualizadoEn: now, completadaEn: now } }, { runValidators: true });
      return this.read(key);
    });
  }

  /** The student's progress in every active lesson of an open module, in lesson order. */
  async moduleProgress(userId: string, moduleId: string) {
    return this.controlled(async () => {
      const usuarioId = this.id(userId), module = await this.access.openModule(userId, this.id(moduleId));
      const lessons = await this.content.activeLessons(module._id);
      await this.storage(false);
      const found = await this.records.find({ usuarioId, leccionId: { $in: lessons.map((l) => l._id) } }).lean();
      const byLesson = new Map(found.map((record) => { const valid = this.checked(record); return [valid.leccionId.toHexString(), valid]; }));
      return { moduloId: module._id.toHexString(), cursoId: module.cursoId.toHexString(),
        items: lessons.map((l) => ({ orden: l.orden, ...this.view(l._id, byLesson.get(l._id.toHexString())) })) };
    });
  }
}
