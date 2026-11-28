import { Injectable } from '@nestjs/common';
import { InjectConnection, InjectModel } from '@nestjs/mongoose';
import { ClientSession, Connection, Model, Types, UpdateQuery } from 'mongoose';
import { LessonProgress, validLessonProgress } from '../domain/lesson-progress';
import { hasLessonProgressUniqueness } from './lesson-progress-indexes';

export type ProgressKey = { usuarioId: Types.ObjectId; leccionId: Types.ObjectId };

/**
 * Persistence of `progreso_leccion`. It performs no authorization and no module gating: callers decide who may
 * write what. It has no dependency on module access, so activities (and later the unlock rule) can use it
 * without creating a module cycle.
 */
@Injectable()
export class LessonProgressStore {
  constructor(@InjectConnection() private readonly connection: Connection,
    @InjectModel('ProgresoLeccion') private readonly records: Model<LessonProgress>) {}

  /** An unprepared storage must fail, never look like a student without progress. */
  async assertStorage(write: boolean): Promise<void> {
    if (this.connection.readyState !== 1 || !this.connection.db) throw new Error('Sin conexión');
    const names = await this.connection.db.listCollections({ name: 'progreso_leccion' }, { nameOnly: true }).toArray();
    if (names.length !== 1 || (write && !(await hasLessonProgressUniqueness(this.connection.db)))) throw new Error('Almacenamiento sin preparar');
  }
  private checked(record: unknown) {
    if (!validLessonProgress(record)) throw new Error('Progreso incompatible');
    return record;
  }
  async get(key: ProgressKey) {
    return this.checked(await this.records.findOne(key).lean());
  }
  async find(usuarioId: Types.ObjectId, leccionIds: Types.ObjectId[]) {
    return (await this.records.find({ usuarioId, leccionId: { $in: leccionIds } }).lean()).map((record) => this.checked(record));
  }
  /**
   * Concurrent first writes can both try to insert; the unique index rejects one, which then updates.
   * Inside a transaction the error aborts it, so retrying belongs to the owner of the transaction.
   */
  private async upsert(key: ProgressKey, update: UpdateQuery<LessonProgress>, session?: ClientSession): Promise<void> {
    const write = () => this.records.updateOne(key, update, { upsert: true, runValidators: true, session });
    try { await write(); }
    catch (error) { if (session || (error as { code?: unknown }).code !== 11000) throw error; await write(); }
  }
  /** Saves the reading position. It never changes the state of a completed lesson. */
  async savePosition(key: ProgressKey, puntoActual: number): Promise<void> {
    await this.upsert(key, { $set: { puntoActual, actualizadoEn: new Date() }, $setOnInsert: { estado: 'en_progreso', completadaEn: null } });
  }
  /** Completes the lesson once: a record that is already completed keeps its original date. */
  async markCompleted(key: ProgressKey, puntoActual: number, session?: ClientSession): Promise<void> {
    const now = new Date();
    await this.upsert(key, { $setOnInsert: { estado: 'completada', puntoActual, actualizadoEn: now, completadaEn: now } }, session);
    await this.records.updateOne({ ...key, estado: 'en_progreso' }, { $set: { estado: 'completada', actualizadoEn: now, completadaEn: now } }, { runValidators: true, session });
  }
}
