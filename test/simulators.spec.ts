import { BadRequestException, ConflictException, ForbiddenException, NotFoundException, ServiceUnavailableException } from '@nestjs/common';
import { Connection, Model, Types } from 'mongoose';
import { LearningContentService } from '../src/modules/learning/application/learning-content.service';
import { ModuleAccessService } from '../src/modules/module-access/application/module-access.service';
import { LessonProgressStore } from '../src/modules/progress/infrastructure/lesson-progress.store';
import { SimulatorsService } from '../src/modules/simulators/application/simulators.service';
import { MAX_DECISION_LENGTH, Simulator, SimulatorResponse, validSimulator, validSimulatorResponse } from '../src/modules/simulators/domain/simulator';
import { courseFixture, lessonFixture, moduleFixture } from './learning-fixtures';
import { simulatorFixture } from './simulators-fixtures';

const moduloId = new Types.ObjectId();
const answerFixture = (overrides: Record<string, unknown> = {}) => ({
  _id: new Types.ObjectId(), usuarioId: new Types.ObjectId(), simuladorId: new Types.ObjectId(), cursoId: new Types.ObjectId(), moduloId,
  version: 1, decision: 'Respuesta sintética.', fecha: new Date(), estadoIA: 'pendiente_ia', ...overrides,
});

describe('Dominio de simuladores', () => {
  it('acepta un caso y una respuesta completos', () => {
    expect(validSimulator(simulatorFixture(moduloId))).toBe(true);
    expect(validSimulatorResponse(answerFixture({ decision: 'x'.repeat(MAX_DECISION_LENGTH) }))).toBe(true);
  });
  it.each([
    ['contexto vacío', { contexto: ' ' }],
    ['consigna que no es texto', { consigna: {} as unknown as string }],
    ['modo desconocido', { modo: 'otro' as never }],
    ['versión cero', { version: 0 }],
  ])('rechaza caso inválido: %s', (_name, overrides) => expect(validSimulator(simulatorFixture(moduloId, overrides))).toBe(false));
  it.each([
    ['decisión vacía', { decision: '  ' }],
    ['decisión demasiado larga', { decision: 'x'.repeat(MAX_DECISION_LENGTH + 1) }],
    ['estado de IA desconocido', { estadoIA: 'aprobada' }],
    ['fecha inválida', { fecha: new Date('x') }],
  ])('rechaza respuesta inválida: %s', (_name, overrides) => expect(validSimulatorResponse(answerFixture(overrides))).toBe(false));
});

describe('SimulatorsService', () => {
  const course = courseFixture(), module = moduleFixture(course._id, 1), user = new Types.ObjectId(), userId = user.toHexString();
  const simulator = simulatorFixture(module._id);
  const reading = lessonFixture(module._id, 1);
  const activity = lessonFixture(module._id, 9, { secciones: [{ tipo: 'parrafo', texto: 'x' }, { tipo: 'recurso', recurso: 'simulador' }] });
  const simulators = { findOne: jest.fn(), find: jest.fn() }, responses = { create: jest.fn(), find: jest.fn() };
  const content = { activeLessons: jest.fn() }, access = { openModule: jest.fn() };
  const progress = { assertStorage: jest.fn(), markCompleted: jest.fn() };
  const collections = jest.fn();
  const session = { withTransaction: jest.fn(), endSession: jest.fn() };
  const connection = { readyState: 1, db: { listCollections: () => ({ toArray: collections }) }, startSession: jest.fn() };
  const service = () => new SimulatorsService(connection as unknown as Connection, simulators as unknown as Model<Simulator>,
    responses as unknown as Model<SimulatorResponse>, content as unknown as LearningContentService, access as unknown as ModuleAccessService,
    progress as unknown as LessonProgressStore);
  const send = (version = 1) => service().respond(userId, simulator._id.toHexString(), { version, decision: 'Mi decisión sintética.' });

  beforeEach(() => {
    jest.resetAllMocks();
    simulators.findOne.mockReturnValue({ lean: async () => simulator });
    access.openModule.mockResolvedValue(module); content.activeLessons.mockResolvedValue([reading, activity]);
    collections.mockResolvedValue([{ name: 'respuestas_simulador' }]);
    connection.startSession.mockResolvedValue(session);
    session.withTransaction.mockImplementation(async (work: () => Promise<void>) => work());
  });

  it('guarda como pendiente_ia, sin retroalimentación, y completa solo la lección del simulador en la misma transacción', async () => {
    const result = await send();
    expect(result).toEqual({ id: expect.any(String), simuladorId: simulator._id.toHexString(), version: 1, decision: 'Mi decisión sintética.', fecha: expect.any(String), estadoIA: 'pendiente_ia' });
    expect(access.openModule).toHaveBeenCalledWith(userId, simulator.moduloId);
    expect(responses.create).toHaveBeenCalledWith([expect.objectContaining({ usuarioId: user, cursoId: course._id, moduloId: module._id, estadoIA: 'pendiente_ia' })], { session });
    expect(progress.markCompleted.mock.calls).toEqual([[{ usuarioId: user, leccionId: activity._id }, 1, session]]);
    expect(session.endSession).toHaveBeenCalledTimes(1);
  });
  it('una versión distinta a la del caso responde 409 sin escribir', async () => {
    await expect(send(2)).rejects.toBeInstanceOf(ConflictException);
    expect(responses.create).not.toHaveBeenCalled();
  });
  it('caso no disponible, módulo bloqueado o id inválido no escriben', async () => {
    simulators.findOne.mockReturnValue({ lean: async () => null });
    await expect(send()).rejects.toBeInstanceOf(NotFoundException);
    await expect(service().respond(userId, '123', { version: 1, decision: 'x' })).rejects.toBeInstanceOf(BadRequestException);
    simulators.findOne.mockReturnValue({ lean: async () => simulator }); access.openModule.mockRejectedValue(new ForbiddenException());
    await expect(send()).rejects.toBeInstanceOf(ForbiddenException);
    expect(responses.create).not.toHaveBeenCalled();
  });
  it('una carrera sobre el progreso repite la transacción una vez', async () => {
    progress.markCompleted.mockRejectedValueOnce(Object.assign(new Error('duplicado'), { code: 11000 }));
    await expect(send()).resolves.toMatchObject({ estadoIA: 'pendiente_ia' });
    expect(session.withTransaction).toHaveBeenCalledTimes(2); expect(session.endSession).toHaveBeenCalledTimes(2);
  });
  it.each([
    ['sin la colección de respuestas', () => collections.mockResolvedValue([])],
    ['progreso sin preparar', () => progress.assertStorage.mockRejectedValue(new Error('sin índice'))],
    ['fallo de escritura', () => responses.create.mockRejectedValue(new Error('mongodb://secreto'))],
    ['caso incompatible', () => simulators.findOne.mockReturnValue({ lean: async () => ({ ...simulator, contexto: '' }) })],
  ])('%s: 503 sanitizado', async (_name, arrange) => {
    arrange();
    const error = await send().catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ServiceUnavailableException);
    expect(JSON.stringify((error as ServiceUnavailableException).getResponse())).not.toMatch(/mongodb|secreto|índice/);
  });
  it('lista los casos sin campos internos', async () => {
    simulators.find.mockReturnValue({ sort: () => ({ lean: async () => [{ ...simulator, respuestaGuia: 'privada' }] }) });
    const result = await service().list(userId, module._id.toHexString());
    expect(result.items).toEqual([{ id: simulator._id.toHexString(), titulo: simulator.titulo, version: 1, contexto: simulator.contexto, consigna: simulator.consigna, modo: 'ia_asistida' }]);
    expect(simulators.find).toHaveBeenCalledWith({ moduloId: module._id, activo: true });
  });
  it('el historial filtra por el estudiante autenticado y pagina', async () => {
    const found = [answerFixture(), answerFixture()];
    responses.find.mockReturnValue({ sort: () => ({ skip: () => ({ limit: () => ({ lean: async () => found }) }) }) });
    const result = await service().history(userId, simulator._id.toHexString(), { pagina: 1, limite: 1 });
    expect(result).toMatchObject({ pagina: 1, limite: 1, hayMas: true }); expect(result.items).toHaveLength(1);
    expect(responses.find).toHaveBeenCalledWith({ usuarioId: user, simuladorId: simulator._id });
    expect(JSON.stringify(result)).not.toContain('usuarioId');
  });
});
