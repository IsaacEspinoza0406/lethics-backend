import { Global, INestApplication, Logger, Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { getConnectionToken } from '@nestjs/mongoose';
import { Test } from '@nestjs/testing';
import mongoose, { Connection, Types } from 'mongoose';
import { randomBytes } from 'node:crypto';
import request from 'supertest';
import { configureApp } from '../src/configure-app';
import { AccessTokenService } from '../src/infrastructure/security/access-token.service';
import { ModuleProgressPort } from '../src/modules/module-access/application/module-progress';
import { ProgressModule } from '../src/modules/progress/progress.module';
import { optionalMongoTestScope } from './integration-isolation';
import { courseFixture, lessonFixture, moduleFixture } from './learning-fixtures';

const scope = optionalMongoTestScope(process.env.LETHICS_IDENTITY_TEST_URI, 'ops');
(scope ? describe : describe.skip)('Progreso de lecciones: MongoDB propio y HTTP', () => {
  let app: INestApplication, connection: Connection, access: string, otherAccess: string, otherRoleAccess: string;
  const user = new Types.ObjectId(), other = new Types.ObjectId(), otherRole = new Types.ObjectId();
  const logs: string[] = [], spies: jest.SpyInstance[] = [];
  const progress = { completedModules: jest.fn(async (): Promise<readonly string[]> => []) };
  @Global()
  @Module({ providers: [{ provide: getConnectionToken(), useFactory: () => connection }], exports: [getConnectionToken()] })
  class TemporaryConnectionModule {}
  const raw = (name: string) => connection.db!.collection(name);
  const installIndex = () => raw('progreso_leccion').createIndex({ usuarioId: 1, leccionId: 1 }, { name: 'usuarioId_1_leccionId_1', unique: true });

  beforeAll(async () => {
    for (const level of ['log', 'error', 'warn', 'debug', 'verbose'] as const) spies.push(jest.spyOn(Logger.prototype, level).mockImplementation((...values: unknown[]) => { logs.push(values.map(String).join(' ')); }));
    const temporary = await scope!.open(); connection = mongoose.createConnection().setClient(temporary.client);
    // Only approved collections, created in the owned UUID database.
    for (const name of ['usuarios', 'cursos', 'modulos', 'lecciones', 'progreso_leccion']) await temporary.db.createCollection(name);
    await installIndex();
    await temporary.db.collection('usuarios').insertMany([{ _id: user, rol: 'estudiante' }, { _id: other, rol: 'estudiante' }, { _id: otherRole, rol: 'no-aprobado' }].map(({ _id, rol }, i) => ({ _id, nombre: 'Sintético', correo: `progress-${i}@example.test`, rol, verificadoEn: new Date(), contraseñaHash: 'synthetic-private-password-hash' })));
    const settings = { NODE_ENV: 'test', AUTH_HTTP_ENABLED: false, JWT_ACCESS_SECRET_BASE64: randomBytes(32).toString('base64'), JWT_ACCESS_ISSUER: 'progress-test', JWT_ACCESS_AUDIENCE: 'progress-test', JWT_ACCESS_TTL_SECONDS: 900,
      VERIFICATION_CODE_HMAC_KEY_BASE64: randomBytes(32).toString('base64'), RATE_LIMIT_HMAC_KEY_BASE64: randomBytes(32).toString('base64'), VERIFICATION_ACCOUNT_FAILURES_PER_HOUR: 20, VERIFICATION_ACCOUNT_EMISSIONS_PER_HOUR: 5 };
    const module = await Test.createTestingModule({ imports: [TemporaryConnectionModule, ConfigModule.forRoot({ isGlobal: true, ignoreEnvFile: true, load: [() => settings] }), ProgressModule] })
      .overrideProvider(ModuleProgressPort).useValue(progress).compile();
    app = module.createNestApplication(); configureApp(app); await app.init();
    const tokens = app.get(AccessTokenService);
    access = tokens.sign(user.toString()); otherAccess = tokens.sign(other.toString()); otherRoleAccess = tokens.sign(otherRole.toString());
  }, 60000);
  afterAll(async () => {
    try { if (app) await app.close(); } finally { try { await scope?.close(); } finally { try { if (connection) await connection.close(); } finally { spies.forEach((spy) => spy.mockRestore()); } } }
  });

  const server = () => request(app.getHttpServer());
  const get = (path: string, token = access) => server().get(`/api/v1/${path}`).auth(token, { type: 'bearer' });
  const save = (lesson: Types.ObjectId, body: object, token = access) => server().put(`/api/v1/lecciones/${lesson}/progreso`).auth(token, { type: 'bearer' }).send(body);
  const complete = (lesson: Types.ObjectId, token = access) => server().post(`/api/v1/lecciones/${lesson}/completar`).auth(token, { type: 'bearer' });
  const stored = (lesson: Types.ObjectId, student = user) => raw('progreso_leccion').find({ usuarioId: student, leccionId: lesson }).toArray();

  /** Module 1: two reading lessons, the simulator lesson and the quiz lesson. Module 2 stays locked. */
  async function scenario() {
    const course = courseFixture({ titulo: `Curso ${new Types.ObjectId()}` });
    const modules = [1, 2].map((orden) => moduleFixture(course._id, orden));
    const reading = [1, 2].map((orden) => lessonFixture(modules[0]._id, orden));
    const simulator = lessonFixture(modules[0]._id, 9, { secciones: [{ tipo: 'recurso', recurso: 'simulador' }] });
    const quiz = lessonFixture(modules[0]._id, 10, { secciones: [{ tipo: 'recurso', recurso: 'cuestionario' }] });
    const locked = lessonFixture(modules[1]._id, 1);
    await raw('cursos').insertOne(course); await raw('modulos').insertMany(modules); await raw('lecciones').insertMany([...reading, simulator, quiz, locked]);
    return { course, modules, reading, simulator, quiz, locked };
  }

  it('exige autenticación y rol estudiante', async () => {
    const s = await scenario(), lesson = s.reading[0]._id;
    await server().get(`/api/v1/modulos/${s.modules[0]._id}/progreso`).expect(401);
    await server().put(`/api/v1/lecciones/${lesson}/progreso`).send({ puntoActual: 0 }).expect(401);
    await server().post(`/api/v1/lecciones/${lesson}/completar`).expect(401);
    await get(`modulos/${s.modules[0]._id}/progreso`, otherRoleAccess).expect(403);
    await save(lesson, { puntoActual: 0 }, otherRoleAccess).expect(403);
    await complete(lesson, otherRoleAccess).expect(403);
    expect(await stored(lesson, otherRole)).toHaveLength(0);
  });
  it('guarda la posición, completa y persiste en MongoDB; no vuelve a en_progreso', async () => {
    const s = await scenario(), lesson = s.reading[0]._id, path = `modulos/${s.modules[0]._id}/progreso`;
    const empty = await get(path).expect(200);
    expect(empty.body.items.map((i: { estado: string }) => i.estado)).toEqual(Array(4).fill('no_iniciada'));
    expect(empty.headers['cache-control']).toBe('no-store');
    expect((await save(lesson, { puntoActual: 2 }).expect(200)).body).toMatchObject({ estado: 'en_progreso', puntoActual: 2, completadaEn: null });
    const done = (await complete(lesson).expect(200)).body;
    expect(done).toMatchObject({ leccionId: lesson.toHexString(), estado: 'completada', completadaEn: expect.any(String) });
    expect((await complete(lesson).expect(200)).body.completadaEn).toBe(done.completadaEn);
    expect((await save(lesson, { puntoActual: 0 }).expect(200)).body).toMatchObject({ estado: 'completada', puntoActual: 0, completadaEn: done.completadaEn });
    const documents = await stored(lesson);
    expect(documents).toHaveLength(1);
    expect(Object.keys(documents[0]).sort()).toEqual(['_id', 'actualizadoEn', 'completadaEn', 'estado', 'leccionId', 'puntoActual', 'usuarioId']);
    expect(documents[0]).toMatchObject({ estado: 'completada', puntoActual: 0, completadaEn: expect.any(Date) });
    expect((await get(path).expect(200)).body.items.map((i: { orden: number; estado: string }) => [i.orden, i.estado]))
      .toEqual([[1, 'completada'], [2, 'no_iniciada'], [9, 'no_iniciada'], [10, 'no_iniciada']]);
  });
  it('completar directamente una lección sin posición previa la deja en la última sección', async () => {
    const s = await scenario(), lesson = s.reading[1];
    expect((await complete(lesson._id).expect(200)).body).toMatchObject({ estado: 'completada', puntoActual: lesson.secciones.length - 1 });
  });
  it('cada estudiante ve y modifica solo su progreso', async () => {
    const s = await scenario(), lesson = s.reading[0]._id, path = `modulos/${s.modules[0]._id}/progreso`;
    await complete(lesson).expect(200);
    expect((await get(path, otherAccess).expect(200)).body.items[0]).toMatchObject({ estado: 'no_iniciada' });
    await save(lesson, { puntoActual: 1 }, otherAccess).expect(200);
    expect((await get(path).expect(200)).body.items[0]).toMatchObject({ estado: 'completada' });
    expect(await stored(lesson, other)).toMatchObject([{ estado: 'en_progreso', puntoActual: 1 }]);
    await save(lesson, { puntoActual: 1, usuarioId: user.toHexString() }, otherAccess).expect(400);
  });
  it('las lecciones de simulador y cuestionario guardan posición pero no se marcan a mano', async () => {
    const s = await scenario();
    for (const lesson of [s.simulator, s.quiz]) {
      await complete(lesson._id).expect(409);
      expect(await stored(lesson._id)).toHaveLength(0);
      expect((await save(lesson._id, { puntoActual: 0 }).expect(200)).body.estado).toBe('en_progreso');
      await complete(lesson._id).expect(409);
      expect((await stored(lesson._id))[0].estado).toBe('en_progreso');
    }
  });
  it('módulo bloqueado, lección inactiva o datos inválidos no escriben nada', async () => {
    const s = await scenario(), lesson = s.reading[0]._id;
    await save(s.locked._id, { puntoActual: 0 }).expect(403); await complete(s.locked._id).expect(403);
    await get(`modulos/${s.modules[1]._id}/progreso`).expect(403);
    for (const body of [{}, { puntoActual: -1 }, { puntoActual: 1.5 }, { puntoActual: '1' }, { puntoActual: 20 }, { puntoActual: s.reading[0].secciones.length }, { puntoActual: 0, estado: 'completada' }]) await save(lesson, body).expect(400);
    await save(new Types.ObjectId(), { puntoActual: 0 }).expect(404);
    await raw('lecciones').updateOne({ _id: lesson }, { $set: { activo: false } });
    await complete(lesson).expect(404);
    expect(await raw('progreso_leccion').countDocuments({ leccionId: { $in: [lesson, s.locked._id] } })).toBe(0);
  });
  it('escrituras simultáneas dejan un solo registro completado', async () => {
    const s = await scenario(), lesson = s.reading[0]._id;
    const responses = await Promise.all([complete(lesson), save(lesson, { puntoActual: 1 }), complete(lesson), save(lesson, { puntoActual: 2 }), complete(lesson)]);
    expect(responses.map((r) => r.status)).toEqual([200, 200, 200, 200, 200]);
    expect(await stored(lesson)).toMatchObject([{ estado: 'completada', completadaEn: expect.any(Date) }]);
  });
  it('sin el índice único no escribe; un registro incompatible produce 503 sanitizado', async () => {
    const s = await scenario(), lesson = s.reading[0]._id;
    await raw('progreso_leccion').dropIndex('usuarioId_1_leccionId_1');
    try {
      await save(lesson, { puntoActual: 0 }).expect(503); await complete(lesson).expect(503);
      expect(await stored(lesson)).toHaveLength(0);
    } finally { await installIndex(); }
    await raw('progreso_leccion').insertOne({ usuarioId: user, leccionId: lesson, estado: 'inventado', puntoActual: 0, actualizadoEn: new Date(), completadaEn: null });
    const response = await get(`modulos/${s.modules[0]._id}/progreso`).expect(503);
    expect(response.text).not.toMatch(/inventado|Mongo/i);
  });
  it('no filtra datos internos en las respuestas ni en los registros', async () => {
    const s = await scenario(), response = await complete(s.reading[0]._id).expect(200);
    expect(response.text).not.toMatch(/contraseña|hash|token|usuarioId|_id|__v/i);
    expect(logs.join('\n')).not.toMatch(/Bearer|contraseña|synthetic-private/i);
  });
});
