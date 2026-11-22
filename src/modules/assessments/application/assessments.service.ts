import { BadRequestException, ConflictException, HttpException, Injectable, NotFoundException, ServiceUnavailableException } from '@nestjs/common';
import { InjectConnection, InjectModel } from '@nestjs/mongoose';
import { ClientSession, Connection, Model, Types } from 'mongoose';
import { Answer, Attempt, Evaluation, InvalidAnswersError, gradeAnswers, normalizeAnswers, validEvaluation } from '../domain/assessment';
import { calculateGrade } from '../domain/grading';
import { AssessmentContextPort } from './assessment-context';
import { hasAttemptUniqueness } from '../infrastructure/assessment-indexes';

interface SubmitInput { version: number; solicitudId: string; respuestas: Answer[] }
interface Page { pagina: number; limite: number }
interface HistoryQuery extends Page { evaluacionId?: string; moduloId?: string; orden: 'fecha_desc' | 'fecha_asc' | 'porcentaje_desc' | 'porcentaje_asc' }

type StoredEvaluation = Evaluation & { _id: Types.ObjectId };
type StoredAttempt = Attempt & { _id: Types.ObjectId };

@Injectable()
export class AssessmentsService {
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
    return this.context.isAvailable(Object.freeze({ usuarioId: user, evaluacionId: evaluation._id.toHexString(), cursoId: evaluation.cursoId.toHexString(), moduloId: evaluation.moduloId!.toHexString(), version: evaluation.version }));
  }
  private evaluationView(e: StoredEvaluation) {
    return { id: e._id.toHexString(), cursoId: e.cursoId.toHexString(), moduloId: e.moduloId!.toHexString(), tipo: e.tipo, version: e.version, minimoAprobatorio: e.minimoAprobatorio,
      preguntas: e.preguntas.map((q) => ({ id: q.id, texto: q.texto, opciones: q.opciones.map((o) => ({ id: o.id, texto: o.texto })) })) };
  }
  private attemptView(a: StoredAttempt) {
    const grade = calculateGrade(a.aciertos, a.total), answers = normalizeAnswers(a.respuestas);
    if (!(a._id instanceof Types.ObjectId) || !(a.evaluacionId instanceof Types.ObjectId) || !(a.cursoId instanceof Types.ObjectId) || !(a.moduloId instanceof Types.ObjectId) ||
      !Number.isSafeInteger(a.version) || a.version < 1 || typeof a.solicitudId !== 'string' || !a.solicitudId.trim() || answers.length !== a.total ||
      Number(a.porcentaje) !== grade.porcentaje || a.aprobado !== grade.aprobado || !(a.fecha instanceof Date) || !Number.isFinite(a.fecha.getTime())) throw new Error('Historial incompatible');
    return { id: a._id.toHexString(), evaluacionId: a.evaluacionId.toHexString(), cursoId: a.cursoId.toHexString(), moduloId: a.moduloId.toHexString(), version: a.version,
      solicitudId: a.solicitudId, respuestas: answers, ...grade, fecha: a.fecha.toISOString() };
  }
  private replay(record: StoredAttempt, evaluation: Types.ObjectId, input: SubmitInput) {
    if (!record.evaluacionId.equals(evaluation) || record.version !== input.version || JSON.stringify(normalizeAnswers(record.respuestas)) !== JSON.stringify(normalizeAnswers(input.respuestas))) {
      throw new ConflictException('solicitudId ya utilizado para otro envío.');
    }
    return this.attemptView(record);
  }
  private async load(evaluation: Types.ObjectId, user: string, session?: ClientSession): Promise<StoredEvaluation> {
    const query = this.evaluations.findOne({ _id: evaluation, tipo: 'cuestionario', estado: 'publicado' }).select('+preguntas.opcionCorrectaId');
    if (session) query.session(session);
    const record = await query.lean();
    if (!record || !(await this.available(user, record))) throw new NotFoundException('Cuestionario no disponible.');
    return record;
  }
  async get(user: string, evaluationId: string) {
    return this.controlled(async () => { this.id(user); await this.storage(); return this.evaluationView(await this.load(this.id(evaluationId), user)); });
  }
  async list(user: string, input: Page & { moduloId: string }) {
    return this.controlled(async () => {
      this.id(user); await this.storage();
      const records = await this.evaluations.find({ moduloId: this.id(input.moduloId), estado: 'publicado', tipo: 'cuestionario' }).select('+preguntas.opcionCorrectaId')
        .sort({ version: -1, _id: -1 }).skip((input.pagina - 1) * input.limite).limit(input.limite).lean();
      const items = [];
      for (const record of records) if (await this.available(user, record)) items.push(this.evaluationView(record));
      return { items, pagina: input.pagina, limite: input.limite };
    });
  }
  async submit(user: string, evaluationId: string, input: SubmitInput) {
    return this.controlled(async () => {
      const usuarioId = this.id(user), evaluacionId = this.id(evaluationId), respuestas = normalizeAnswers(input.respuestas);
      if (!Number.isSafeInteger(input.version) || input.version < 1 || input.version > 2147483647 || typeof input.solicitudId !== 'string' || !input.solicitudId.trim() || input.solicitudId.length > 128) throw new BadRequestException('Envío inválido.');
      await this.storage(true);
      const filter = { usuarioId, solicitudId: input.solicitudId };
      const existing = await this.attempts.findOne(filter).lean();
      if (existing) return this.replay(existing, evaluacionId, input);
      const session = await this.connection.startSession();
      try {
        try {
          return await session.withTransaction(async () => {
            const previous = await this.attempts.findOne(filter).session(session).lean();
            if (previous) return this.replay(previous, evaluacionId, input);
            const evaluation = await this.load(evaluacionId, user, session);
            if (evaluation.version !== input.version) throw new ConflictException('Versión de evaluación incompatible.');
            const grade = gradeAnswers(evaluation.preguntas, respuestas);
            const [record] = await this.attempts.create([{ usuarioId, evaluacionId, cursoId: evaluation.cursoId, moduloId: evaluation.moduloId, version: evaluation.version,
              solicitudId: input.solicitudId, respuestas, ...grade, fecha: new Date() }], { session });
            return this.attemptView(record.toObject() as StoredAttempt);
          }, { readConcern: { level: 'snapshot' }, writeConcern: { w: 'majority' } });
        } catch (error) {
          if ((error as { code?: number }).code !== 11000) throw error;
          const winner = await this.attempts.findOne(filter).lean();
          if (!winner) throw error;
          return this.replay(winner, evaluacionId, input);
        }
      } finally { await session.endSession(); }
    });
  }
  async history(user: string, input: HistoryQuery) {
    return this.controlled(async () => {
      await this.storage();
      const filter = { usuarioId: this.id(user), ...(input.evaluacionId ? { evaluacionId: this.id(input.evaluacionId) } : {}), ...(input.moduloId ? { moduloId: this.id(input.moduloId) } : {}) };
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
}
