import { BadRequestException, ConflictException, HttpException, Injectable, NotFoundException, ServiceUnavailableException } from '@nestjs/common';
import { InjectConnection, InjectModel } from '@nestjs/mongoose';
import { Connection, Model, Types } from 'mongoose';
import { LearningContentService } from '../../learning/application/learning-content.service';
import { ModuleAccessService } from '../../module-access/application/module-access.service';
import { requiredActivity } from '../../progress/domain/lesson-progress';
import { LessonProgressStore } from '../../progress/infrastructure/lesson-progress.store';
import { Simulator, SimulatorResponse, validSimulator, validSimulatorResponse } from '../domain/simulator';

/**
 * Ethics simulators without AI: the answer is stored as `pendiente_ia` and no feedback is produced.
 * Sending an answer completes the module's simulator lesson, in the same transaction.
 */
@Injectable()
export class SimulatorsService {
  constructor(@InjectConnection() private readonly connection: Connection,
    @InjectModel('Simulador') private readonly simulators: Model<Simulator>,
    @InjectModel('RespuestaSimulador') private readonly responses: Model<SimulatorResponse>,
    private readonly content: LearningContentService, private readonly access: ModuleAccessService,
    private readonly progress: LessonProgressStore) {}

  private async controlled<T>(action: () => Promise<T>): Promise<T> {
    try { return await action(); }
    catch (error) { if (error instanceof HttpException) throw error; throw new ServiceUnavailableException('Simuladores no disponibles.'); }
  }
  private id(value: string): Types.ObjectId {
    if (typeof value !== 'string' || !/^[a-f\d]{24}$/i.test(value)) throw new BadRequestException('Identificador inválido.');
    return new Types.ObjectId(value);
  }
  /** A missing collection must fail, never look like a student without answers. */
  private async responseStorage(): Promise<void> {
    if (this.connection.readyState !== 1 || !this.connection.db) throw new Error('Sin conexión');
    const names = await this.connection.db.listCollections({ name: 'respuestas_simulador' }, { nameOnly: true }).toArray();
    if (names.length !== 1) throw new Error('Almacenamiento sin preparar');
  }
  private checkedSimulator(value: unknown) {
    if (!validSimulator(value)) throw new Error('Simulador incompatible');
    return value;
  }
  private async openSimulator(userId: string, simulatorId: string) {
    const found = await this.simulators.findOne({ _id: this.id(simulatorId), activo: true }).lean();
    if (!found) throw new NotFoundException('Simulador no disponible.');
    const simulator = this.checkedSimulator(found);
    return { simulator, module: await this.access.openModule(userId, simulator.moduloId) };
  }
  private responseView(value: unknown) {
    if (!validSimulatorResponse(value)) throw new Error('Respuesta incompatible');
    return { id: value._id.toHexString(), simuladorId: value.simuladorId.toHexString(), version: value.version, decision: value.decision,
      fecha: value.fecha.toISOString(), estadoIA: value.estadoIA };
  }

  /** Active cases of an open module. */
  async list(userId: string, moduleId: string) {
    return this.controlled(async () => {
      const module = await this.access.openModule(userId, this.id(moduleId));
      const found = await this.simulators.find({ moduloId: module._id, activo: true }).sort({ titulo: 1, _id: 1 }).lean();
      return { moduloId: module._id.toHexString(), cursoId: module.cursoId.toHexString(), items: found.map((value) => {
        const s = this.checkedSimulator(value);
        return { id: s._id.toHexString(), titulo: s.titulo, version: s.version, contexto: s.contexto, consigna: s.consigna, modo: s.modo };
      }) };
    });
  }

  /** Every answer is kept. The answer and the lesson completion are stored together or not at all. */
  async respond(userId: string, simulatorId: string, input: { version: number; decision: string }) {
    return this.controlled(async () => {
      const usuarioId = this.id(userId), { simulator, module } = await this.openSimulator(userId, simulatorId);
      if (input.version !== simulator.version) throw new ConflictException('El caso cambió. Vuelve a cargarlo antes de responder.');
      await this.responseStorage();
      await this.progress.assertStorage(true);
      const lessons = (await this.content.activeLessons(module._id)).filter((l) => requiredActivity(l.secciones) === 'simulador');
      const record = { _id: new Types.ObjectId(), usuarioId, simuladorId: simulator._id, cursoId: module.cursoId, moduloId: module._id,
        version: simulator.version, decision: input.decision, fecha: new Date(), estadoIA: 'pendiente_ia' as const };
      const store = async () => {
        const session = await this.connection.startSession();
        try {
          await session.withTransaction(async () => {
            await this.responses.create([record], { session });
            for (const lesson of lessons) await this.progress.markCompleted({ usuarioId, leccionId: lesson._id }, lesson.secciones.length - 1, session);
          });
        } finally { await session.endSession(); }
      };
      // Two first answers can race to create the same progress record: the aborted transaction runs once more.
      try { await store(); }
      catch (error) { if ((error as { code?: unknown }).code !== 11000) throw error; await store(); }
      return this.responseView(record);
    });
  }

  /** The student's own answers to a case, newest first. */
  async history(userId: string, simulatorId: string, page: { pagina: number; limite: number }) {
    return this.controlled(async () => {
      const usuarioId = this.id(userId), { simulator } = await this.openSimulator(userId, simulatorId);
      await this.responseStorage();
      const found = await this.responses.find({ usuarioId, simuladorId: simulator._id }).sort({ fecha: -1, _id: -1 })
        .skip((page.pagina - 1) * page.limite).limit(page.limite + 1).lean();
      return { items: found.slice(0, page.limite).map((value) => this.responseView(value)), pagina: page.pagina, limite: page.limite, hayMas: found.length > page.limite };
    });
  }
}
