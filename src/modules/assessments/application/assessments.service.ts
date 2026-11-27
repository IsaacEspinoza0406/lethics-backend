import { BadRequestException, ConflictException, ForbiddenException, HttpException, Injectable, NotFoundException, ServiceUnavailableException } from '@nestjs/common';
import { InjectConnection, InjectModel } from '@nestjs/mongoose';
import { ClientSession, Connection, Model, Types } from 'mongoose';
import { Answer, Attempt, Evaluation, InvalidAnswersError, gradeAnswers, normalizeAnswers, validEvaluation } from '../domain/assessment';
import { calculateGrade } from '../domain/grading';
import { AssessmentContextPort, AssessmentResultsPort, QuizResult } from './assessment-context';
import { hasAttemptUniqueness } from '../infrastructure/assessment-indexes';
import { FINAL_EXAM_ATTEMPTS, finalAttemptId } from '../domain/final-exam';

interface SubmitInput { version: number; solicitudId: string; respuestas: Answer[] }
interface Page { pagina: number; limite: number }
interface HistoryQuery extends Page { evaluacionId?: string; moduloId?: string; cursoId?: string; orden: 'fecha_desc' | 'fecha_asc' | 'porcentaje_desc' | 'porcentaje_asc' }

type StoredEvaluation = Evaluation & { _id: Types.ObjectId };
type StoredAttempt = Attempt & { _id: Types.ObjectId };

@Injectable()
export class AssessmentsService implements AssessmentResultsPort {
  constructor(@InjectConnection() private readonly connection: Connection,
    @InjectModel('Evaluacion') private readonly evaluations: Model<Evaluation>, @InjectModel('IntentoEvaluacion') private readonly attempts: Model<Attempt>,
    private readonly context: AssessmentContextPort) {}

  private async controlled<T>(action: () => Promise<T>): Promise<T> {
    try { return await action(); }
    catch (error) {
      if (error instanceof HttpException) throw error;
      if (error instanceof InvalidAnswersError) throw new BadRequestException('Respuestas de evaluación inválidas.');
      throw new ServiceUnavailableException('Evaluaciones no disponibles.');
    }
  }
  private id(value: string): Types.ObjectId {
    if (!/^[a-f\d]{24}$/i.test(value)) throw new BadRequestException('Identificador inválido.');
    return new Types.ObjectId(value);
  }
  private async storage(write = false): Promise<void> {
    if (this.connection.readyState !== 1 || !this.connection.db) throw new Error('Sin conexión');
    const names = await this.connection.db.listCollections({ name: { $in: ['evaluaciones', 'intentos_evaluacion'] } }, { nameOnly: true }).toArray();
    if (names.length !== 2 || (write && !(await hasAttemptUniqueness(this.connection.db)))) throw new Error('Almacenamiento sin preparar');
  }
  private async available(user: string, evaluation: StoredEvaluation): Promise<boolean> {
    if (!validEvaluation(evaluation)) throw new Error('Contenido incompatible');
    const descriptor = { usuarioId: user, evaluacionId: evaluation._id.toHexString(), cursoId: evaluation.cursoId.toHexString(), version: evaluation.version };
    if (evaluation.tipo === 'cuestionario') return this.context.isAvailable(Object.freeze({ ...descriptor, moduloId: evaluation.moduloId!.toHexString() }));
    const eligibility = await this.context.finalExamEligibility(Object.freeze({ ...descriptor, moduloId: null }));
    if (!eligibility || typeof eligibility.proyectoEntregado !== 'boolean' || !Array.isArray(eligibility.modulosCompletados) ||
      eligibility.modulosCompletados.length > 5 || !eligibility.modulosCompletados.every((id) => typeof id === 'string' && /^[a-f\d]{24}$/i.test(id)) ||
      new Set(eligibility.modulosCompletados.map((id) => id.toLowerCase())).size !== eligibility.modulosCompletados.length || typeof eligibility.cursoId !== 'string') throw new Error('Elegibilidad incompatible');
    return eligibility.cursoId === descriptor.cursoId && eligibility.modulosCompletados.length === 5 && eligibility.proyectoEntregado;
  }
  private evaluationView(e: StoredEvaluation) {
    return { id: e._id.toHexString(), cursoId: e.cursoId.toHexString(), moduloId: e.moduloId?.toHexString() ?? null, tipo: e.tipo, version: e.version, minimoAprobatorio: e.minimoAprobatorio,
      preguntas: e.preguntas.map((q) => ({ id: q.id, texto: q.texto, opciones: q.opciones.map((o) => ({ id: o.id, texto: o.texto })) })) };
  }
  private attemptView(a: StoredAttempt) {
    const grade = calculateGrade(a.aciertos, a.total), answers = normalizeAnswers(a.respuestas);
    if (!(a._id instanceof Types.ObjectId) || !(a.evaluacionId instanceof Types.ObjectId) || !(a.cursoId instanceof Types.ObjectId) || (a.moduloId !== null && !(a.moduloId instanceof Types.ObjectId)) ||
      !Number.isSafeInteger(a.version) || a.version < 1 || typeof a.solicitudId !== 'string' || !a.solicitudId.trim() || answers.length !== a.total ||
      Number(a.porcentaje) !== grade.porcentaje || a.aprobado !== grade.aprobado || !(a.fecha instanceof Date) || !Number.isFinite(a.fecha.getTime())) throw new Error('Historial incompatible');
    return { id: a._id.toHexString(), evaluacionId: a.evaluacionId.toHexString(), cursoId: a.cursoId.toHexString(), moduloId: a.moduloId?.toHexString() ?? null, version: a.version,
      solicitudId: a.solicitudId, respuestas: answers, ...grade, fecha: a.fecha.toISOString() };
  }
  private replay(record: StoredAttempt, evaluation: Types.ObjectId, input: SubmitInput) {
    if (!record.evaluacionId.equals(evaluation) || record.version !== input.version || JSON.stringify(normalizeAnswers(record.respuestas)) !== JSON.stringify(normalizeAnswers(input.respuestas))) {
      throw new ConflictException('solicitudId ya utilizado para otro envío.');
    }
    return this.attemptView(record);
  }
  private async finalCount(usuarioId: Types.ObjectId, cursoId: Types.ObjectId, session?: ClientSession): Promise<number> {
    // Approved invariant: quiz attempts have a module; final attempts have module=null.
    // Includes legacy/random IDs and all evaluation versions, conservatively including absent module.
    const query = this.attempts.countDocuments({ usuarioId, cursoId, moduloId: null });
    if (session) query.session(session);
    return query.exec();
  }
  private async load(evaluation: Types.ObjectId, user: string, session?: ClientSession, cursoId?: string): Promise<StoredEvaluation> {
    const query = this.evaluations.findOne({ _id: evaluation, estado: 'publicado' }).select('+preguntas.opcionCorrectaId');
    if (session) query.session(session);
    const record = await query.lean();
    if (!record) throw new NotFoundException('Evaluación no disponible.');
    if (record.tipo === 'examen_final' && !cursoId) throw new BadRequestException('cursoId es obligatorio para el examen final.');
    if (cursoId && !record.cursoId.equals(this.id(cursoId))) throw new NotFoundException('Evaluación no disponible.');
    if (!(await this.available(user, record))) {
      if (record.tipo === 'examen_final') throw new ForbiddenException('Completa los cinco módulos y registra una entrega válida del proyecto.');
      throw new NotFoundException('Cuestionario no disponible.');
    }
    if (record.tipo === 'examen_final' && await this.finalCount(this.id(user), record.cursoId, session) >= FINAL_EXAM_ATTEMPTS) throw new ForbiddenException('Límite de tres intentos del examen final agotado.');
    return record;
  }
  async get(user: string, evaluationId: string, cursoId?: string) {
    return this.controlled(async () => { this.id(user); await this.storage(); return this.evaluationView(await this.load(this.id(evaluationId), user, undefined, cursoId)); });
  }
  async list(user: string, input: Page & { moduloId?: string; cursoId?: string; tipo?: 'cuestionario' | 'examen_final' }) {
    return this.controlled(async () => {
      this.id(user); await this.storage();
      const final = input.tipo === 'examen_final';
      if (final ? (!input.cursoId || input.moduloId !== undefined) : !input.moduloId) throw new BadRequestException('Filtro de evaluación inválido.');
      const filter = { estado: 'publicado', tipo: final ? 'examen_final' : 'cuestionario', moduloId: final ? null : this.id(input.moduloId!), ...(input.cursoId ? { cursoId: this.id(input.cursoId) } : {}) };
      const records = await this.evaluations.find(filter).select('+preguntas.opcionCorrectaId')
        .sort({ version: -1, _id: -1 }).skip((input.pagina - 1) * input.limite).limit(input.limite).lean();
      const items = [];
      for (const record of records) if (await this.available(user, record) && (!final || await this.finalCount(this.id(user), record.cursoId) < FINAL_EXAM_ATTEMPTS)) items.push(this.evaluationView(record));
      return { items, pagina: input.pagina, limite: input.limite };
    });
  }
  async submit(user: string, evaluationId: string, input: SubmitInput, cursoId?: string) {
    return this.controlled(async () => {
      const usuarioId = this.id(user), evaluacionId = this.id(evaluationId), respuestas = normalizeAnswers(input.respuestas);
      if (!Number.isSafeInteger(input.version) || input.version < 1 || input.version > 2147483647 || typeof input.solicitudId !== 'string' || !input.solicitudId.trim() || input.solicitudId.length > 128) throw new BadRequestException('Envío inválido.');
      await this.storage(true);
      const filter = { usuarioId, solicitudId: input.solicitudId };
      const existing = await this.attempts.findOne(filter).lean();
      if (cursoId) this.id(cursoId);
      const replay = (record: StoredAttempt) => {
        if (cursoId && !record.cursoId.equals(this.id(cursoId))) throw new NotFoundException('Evaluación no disponible.');
        if (record.moduloId === null && !cursoId) throw new BadRequestException('cursoId es obligatorio para el examen final.');
        return this.replay(record, evaluacionId, input);
      };
      if (existing) return replay(existing);
      const session = await this.connection.startSession();
      try {
        // At most three slot conflicts can be won by other final submissions. One more
        // transaction observes exhaustion. Unique-id collisions never overwrite a document.
        for (let contention = 0; contention <= FINAL_EXAM_ATTEMPTS; contention++) {
          try {
          return await session.withTransaction(async () => {
            const previous = await this.attempts.findOne(filter).session(session).lean();
            if (previous) return replay(previous);
            const evaluation = await this.load(evaluacionId, user, session, cursoId);
            if (evaluation.version !== input.version) throw new ConflictException('Versión de evaluación incompatible.');
            const grade = gradeAnswers(evaluation.preguntas, respuestas);
            const slot = evaluation.tipo === 'examen_final' ? finalAttemptId(usuarioId, evaluation.cursoId, await this.finalCount(usuarioId, evaluation.cursoId, session) + 1) : undefined;
            const [record] = await this.attempts.create([{ ...(slot ? { _id: slot } : {}), usuarioId, evaluacionId, cursoId: evaluation.cursoId, moduloId: evaluation.moduloId, version: evaluation.version,
              solicitudId: input.solicitudId, respuestas, ...grade, fecha: new Date() }], { session });
            return this.attemptView(record.toObject() as StoredAttempt);
          }, { readConcern: { level: 'snapshot' }, writeConcern: { w: 'majority' } });
          } catch (error) {
          if ((error as { code?: number }).code !== 11000) throw error;
          const winner = await this.attempts.findOne(filter).lean();
            if (winner) return replay(winner);
            if (contention === FINAL_EXAM_ATTEMPTS) throw error;
          }
        }
      } finally { await session.endSession(); }
    });
  }
  async history(user: string, input: HistoryQuery) {
    return this.controlled(async () => {
      await this.storage();
      const filter = { usuarioId: this.id(user), ...(input.evaluacionId ? { evaluacionId: this.id(input.evaluacionId) } : {}), ...(input.moduloId ? { moduloId: this.id(input.moduloId) } : {}), ...(input.cursoId ? { cursoId: this.id(input.cursoId) } : {}) };
      const order: Record<string, 1 | -1> = input.orden === 'fecha_asc' ? { fecha: 1, _id: 1 } : input.orden === 'porcentaje_desc' ? { porcentaje: -1, fecha: -1, _id: -1 } : input.orden === 'porcentaje_asc' ? { porcentaje: 1, fecha: -1, _id: -1 } : { fecha: -1, _id: -1 };
      const records = await this.attempts.find(filter).sort(order).skip((input.pagina - 1) * input.limite).limit(input.limite + 1).lean();
      return { items: records.slice(0, input.limite).map((record) => this.attemptView(record)), pagina: input.pagina, limite: input.limite, hayMas: records.length > input.limite };
    });
  }
  async getAttempt(user: string, attemptId: string) {
    return this.controlled(async () => {
      await this.storage();
      const record = await this.attempts.findOne({ _id: this.id(attemptId), usuarioId: this.id(user) }).lean();
      if (!record) throw new NotFoundException('Intento no disponible.');
      return this.attemptView(record);
    });
  }
  async hasPassedFinalExam(user: string, course: string): Promise<boolean> {
    return this.controlled(async () => {
      await this.storage();
      const results = await this.attempts.aggregate([
        { $match: { usuarioId: this.id(user), cursoId: this.id(course), moduloId: null, aprobado: true, porcentaje: { $gte: 70 } } },
        { $lookup: { from: 'evaluaciones', localField: 'evaluacionId', foreignField: '_id', as: 'evaluacion' } },
        { $match: { 'evaluacion.tipo': 'examen_final', 'evaluacion.cursoId': this.id(course) } },
        { $limit: 1 }, { $project: { _id: 1 } },
      ]);
      return results.length > 0;
    });
  }
  async quizResults(user: string, course: string): Promise<QuizResult[]> {
    return this.controlled(async () => {
      const usuarioId = this.id(user), cursoId = this.id(course);
      await this.storage();
      // Stream histories instead of materializing all repeated attempts in memory.
      // Both collections belong to Backend A; availability/progress is deliberately not consulted.
      const cursor = this.attempts.aggregate<StoredAttempt & { evaluacion: StoredEvaluation }>([
        { $match: { usuarioId, cursoId, moduloId: { $type: 'objectId' } } },
        { $lookup: { from: 'evaluaciones', localField: 'evaluacionId', foreignField: '_id', as: 'evaluacion' } },
        { $unwind: '$evaluacion' },
        { $match: { 'evaluacion.tipo': 'cuestionario' } },
        { $project: { _id: 1, usuarioId: 1, evaluacionId: 1, cursoId: 1, moduloId: 1, version: 1, solicitudId: 1,
          respuestas: 1, aciertos: 1, total: 1, porcentaje: 1, aprobado: 1, fecha: 1, evaluacion: 1 } },
      ]).cursor({ batchSize: 100 });
      const results = new Map<string, boolean>();
      try {
        for await (const record of cursor) {
          // Pure validation only: malformed historical documents are excluded, not repaired.
          // Cursor/network errors remain outside this block and propagate as controlled 503.
          try {
            const evaluation = record.evaluacion;
            if (!validEvaluation(evaluation) || evaluation.tipo !== 'cuestionario' || !(evaluation._id instanceof Types.ObjectId) ||
              !(record.usuarioId instanceof Types.ObjectId) || !record.usuarioId.equals(usuarioId) ||
              !(record.cursoId instanceof Types.ObjectId) || !record.cursoId.equals(cursoId) || !evaluation.cursoId.equals(cursoId) ||
              !(record.moduloId instanceof Types.ObjectId) || !record.moduloId.equals(evaluation.moduloId!) ||
              !(record.evaluacionId instanceof Types.ObjectId) || !record.evaluacionId.equals(evaluation._id) || record.version !== evaluation.version ||
              typeof record.solicitudId !== 'string' || record.solicitudId.length > 128) continue;
            this.attemptView(record);
            const expected = gradeAnswers(evaluation.preguntas, record.respuestas);
            if (record.aciertos !== expected.aciertos || record.total !== expected.total || Number(record.porcentaje) !== expected.porcentaje || record.aprobado !== expected.aprobado) continue;
            const moduloId = record.moduloId.toHexString();
            results.set(moduloId, results.get(moduloId) === true || expected.aprobado);
          } catch { /* Invalid/incomplete attempt or evaluation; never count it as submitted. */ }
        }
      } finally { await cursor.close(); }
      return [...results].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([moduloId, aprobado]) => ({ moduloId, aprobado }));
    });
  }
}
