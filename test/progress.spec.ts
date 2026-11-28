import { BadRequestException, ConflictException, ForbiddenException, NotFoundException, ServiceUnavailableException } from '@nestjs/common';
import { Connection, Model, Types } from 'mongoose';
import { LearningContentService } from '../src/modules/learning/application/learning-content.service';
import { ModuleAccessService } from '../src/modules/module-access/application/module-access.service';
import { LessonProgressService } from '../src/modules/progress/application/lesson-progress.service';
import { LessonProgress, requiredActivity, validLessonProgress } from '../src/modules/progress/domain/lesson-progress';
import { hasLessonProgressUniqueness } from '../src/modules/progress/infrastructure/lesson-progress-indexes';
import { courseFixture, lessonFixture, moduleFixture, sampleBlocks } from './learning-fixtures';

const record = (overrides: Record<string, unknown> = {}) => ({
  _id: new Types.ObjectId(), usuarioId: new Types.ObjectId(), leccionId: new Types.ObjectId(),
  estado: 'en_progreso', puntoActual: 0, actualizadoEn: new Date(), completadaEn: null, ...overrides,
});

describe('Dominio del progreso de lecciones', () => {
  it('distingue las lecciones de actividad de las de lectura', () => {
    expect(requiredActivity(sampleBlocks())).toBeUndefined(); // flashcards no cambia la forma de completar
    expect(requiredActivity([{ tipo: 'parrafo', texto: 'x' }, { tipo: 'recurso', recurso: 'simulador' }])).toBe('simulador');
    expect(requiredActivity([{ tipo: 'recurso', recurso: 'cuestionario' }])).toBe('cuestionario');
  });
  it('acepta registros coherentes', () => {
    expect(validLessonProgress(record())).toBe(true);
    expect(validLessonProgress(record({ estado: 'completada', completadaEn: new Date(), puntoActual: 5 }))).toBe(true);
  });
  it.each([
    ['estado desconocido', { estado: 'aprobada' }],
    ['completada sin fecha', { estado: 'completada' }],
    ['en progreso con fecha de finalización', { completadaEn: new Date() }],
    ['posición negativa', { puntoActual: -1 }],
    ['posición decimal', { puntoActual: 1.5 }],
    ['posición fuera de límite', { puntoActual: 20 }],
    ['fecha inválida', { actualizadoEn: new Date('x') }],
    ['usuario sin ObjectId', { usuarioId: 'abc' }],
  ])('rechaza registro incompatible: %s', (_name, overrides) => expect(validLessonProgress(record(overrides))).toBe(false));
});

describe('Índice único de progreso_leccion', () => {
  const index = { key: { usuarioId: 1, leccionId: 1 }, unique: true };
  const check = (indexes: unknown[]) => hasLessonProgressUniqueness({ collection: () => ({ listIndexes: () => ({ toArray: async () => indexes }) }) } as never);
  it('acepta el índice aprobado', async () => expect(await check([index])).toBe(true));
  it.each([
    ['ausente', []],
    ['no único', [{ key: index.key }]],
    ['en otro orden', [{ key: { leccionId: 1, usuarioId: 1 }, unique: true }]],
    ['parcial', [{ ...index, partialFilterExpression: { estado: 'completada' } }]],
    ['oculto', [{ ...index, hidden: true }]],
    ['disperso', [{ ...index, sparse: true }]],
  ])('rechaza el índice %s', async (_name, indexes) => expect(await check(indexes)).toBe(false));
});

describe('LessonProgressService', () => {
  const course = courseFixture(), module = moduleFixture(course._id, 1), user = new Types.ObjectId();
  const reading = lessonFixture(module._id, 1);
  const activity = lessonFixture(module._id, 9, { secciones: [{ tipo: 'recurso', recurso: 'simulador' }] });
  const content = { activeLesson: jest.fn(), activeLessons: jest.fn() }, access = { openModule: jest.fn() };
  const records = { updateOne: jest.fn(), findOne: jest.fn(), find: jest.fn() };
  const collections = jest.fn(), indexes = jest.fn();
  const connection = { readyState: 1, db: { listCollections: () => ({ toArray: collections }), collection: () => ({ listIndexes: () => ({ toArray: indexes }) }) } };
  const service = (readyState = 1) => new LessonProgressService({ ...connection, readyState } as unknown as Connection,
    records as unknown as Model<LessonProgress>, content as unknown as LearningContentService, access as unknown as ModuleAccessService);
  const stored = (overrides: Record<string, unknown> = {}) => record({ usuarioId: user, leccionId: reading._id, ...overrides });
  const userId = user.toHexString(), lessonId = reading._id.toHexString();

  beforeEach(() => {
    jest.resetAllMocks();
    content.activeLesson.mockResolvedValue(reading); content.activeLessons.mockResolvedValue([reading, activity]);
    access.openModule.mockResolvedValue(module);
    collections.mockResolvedValue([{ name: 'progreso_leccion' }]); indexes.mockResolvedValue([{ key: { usuarioId: 1, leccionId: 1 }, unique: true }]);
    records.updateOne.mockResolvedValue({}); records.findOne.mockReturnValue({ lean: async () => stored() });
    records.find.mockReturnValue({ lean: async () => [stored()] });
  });

  it('guarda la posición del estudiante autenticado sin tocar el estado', async () => {
    const result = await service().save(userId, lessonId, 2);
    expect(result).toMatchObject({ leccionId: lessonId, estado: 'en_progreso', completadaEn: null });
    expect(access.openModule).toHaveBeenCalledWith(userId, reading.moduloId);
    const [key, update] = records.updateOne.mock.calls[0];
    expect(key).toEqual({ usuarioId: user, leccionId: reading._id });
    expect(update.$set).toEqual({ puntoActual: 2, actualizadoEn: expect.any(Date) });
    expect(update.$setOnInsert).toEqual({ estado: 'en_progreso', completadaEn: null });
  });
  it('completar solo cambia registros en progreso, así conserva la primera fecha', async () => {
    records.findOne.mockReturnValue({ lean: async () => stored({ estado: 'completada', completadaEn: new Date(), puntoActual: 5 }) });
    await expect(service().complete(userId, lessonId)).resolves.toMatchObject({ estado: 'completada' });
    expect(records.updateOne.mock.calls[0][1]).toEqual({ $setOnInsert: expect.objectContaining({ estado: 'completada', puntoActual: reading.secciones.length - 1 }) });
    expect(records.updateOne.mock.calls[1][0]).toEqual({ usuarioId: user, leccionId: reading._id, estado: 'en_progreso' });
  });
  it('una lección de actividad no se puede marcar como completada: 409 sin escribir', async () => {
    content.activeLesson.mockResolvedValue(activity);
    await expect(service().complete(userId, activity._id.toHexString())).rejects.toBeInstanceOf(ConflictException);
    expect(records.updateOne).not.toHaveBeenCalled();
  });
  it('una posición que la lección no tiene: 400 sin escribir', async () => {
    await expect(service().save(userId, lessonId, reading.secciones.length)).rejects.toBeInstanceOf(BadRequestException);
    expect(records.updateOne).not.toHaveBeenCalled();
  });
  it('lección no disponible o módulo bloqueado: 404 o 403 sin escribir', async () => {
    content.activeLesson.mockResolvedValue(null);
    await expect(service().save(userId, lessonId, 0)).rejects.toBeInstanceOf(NotFoundException);
    content.activeLesson.mockResolvedValue(reading); access.openModule.mockRejectedValue(new ForbiddenException());
    await expect(service().complete(userId, lessonId)).rejects.toBeInstanceOf(ForbiddenException);
    await expect(service().moduleProgress(userId, module._id.toHexString())).rejects.toBeInstanceOf(ForbiddenException);
    expect(records.updateOne).not.toHaveBeenCalled(); expect(records.find).not.toHaveBeenCalled();
  });
  it('una carrera de inserción se reintenta una vez', async () => {
    records.updateOne.mockRejectedValueOnce(Object.assign(new Error('duplicado'), { code: 11000 }));
    await expect(service().save(userId, lessonId, 1)).resolves.toMatchObject({ estado: 'en_progreso' });
    expect(records.updateOne).toHaveBeenCalledTimes(2);
  });
  it.each([
    ['sin conexión', () => undefined, 0],
    ['sin la colección', () => collections.mockResolvedValue([]), 1],
    ['sin índice único', () => indexes.mockResolvedValue([]), 1],
    ['error de escritura', () => records.updateOne.mockRejectedValue(new Error('mongodb://secreto')), 1],
    ['registro incompatible', () => records.findOne.mockReturnValue({ lean: async () => stored({ estado: 'otro' }) }), 1],
  ])('%s: 503 sanitizado', async (_name, arrange, readyState) => {
    arrange();
    const error = await service(readyState).save(userId, lessonId, 1).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ServiceUnavailableException);
    expect(JSON.stringify((error as ServiceUnavailableException).getResponse())).not.toMatch(/mongodb|secreto/);
  });
  it('el avance del módulo lista cada lección activa, con las no iniciadas', async () => {
    const result = await service().moduleProgress(userId, module._id.toHexString());
    expect(result.items.map((i) => [i.orden, i.estado, i.puntoActual])).toEqual([[1, 'en_progreso', 0], [9, 'no_iniciada', null]]);
    expect(records.find).toHaveBeenCalledWith({ usuarioId: user, leccionId: { $in: [reading._id, activity._id] } });
  });
});
