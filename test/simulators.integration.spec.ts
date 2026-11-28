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
import { SimulatorsModule } from '../src/modules/simulators/simulators.module';
import { optionalMongoTestScope } from './integration-isolation';
import { courseFixture, lessonFixture, moduleFixture } from './learning-fixtures';
import { simulatorFixture } from './simulators-fixtures';

jest.setTimeout(30000);
const scope = optionalMongoTestScope(process.env.LETHICS_IDENTITY_TEST_URI, 'ops');
(scope ? describe : describe.skip)('Simuladores: MongoDB propio y HTTP', () => {
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
    for (const name of ['usuarios', 'cursos', 'modulos', 'lecciones', 'simuladores', 'respuestas_simulador', 'progreso_leccion']) await temporary.db.createCollection(name);
    await installIndex();
    await temporary.db.collection('usuarios').insertMany([{ _id: user, rol: 'estudiante' }, { _id: other, rol: 'estudiante' }, { _id: otherRole, rol: 'no-aprobado' }].map(({ _id, rol }, i) => ({ _id, nombre: 'Sintético', correo: `simulators-${i}@example.test`, rol, verificadoEn: new Date(), contraseñaHash: 'synthetic-private-password-hash' })));
    const settings = { NODE_ENV: 'test', AUTH_HTTP_ENABLED: false, JWT_ACCESS_SECRET_BASE64: randomBytes(32).toString('base64'), JWT_ACCESS_ISSUER: 'simulators-test', JWT_ACCESS_AUDIENCE: 'simulators-test', JWT_ACCESS_TTL_SECONDS: 900,
      VERIFICATION_CODE_HMAC_KEY_BASE64: randomBytes(32).toString('base64'), RATE_LIMIT_HMAC_KEY_BASE64: randomBytes(32).toString('base64'), VERIFICATION_ACCOUNT_FAILURES_PER_HOUR: 20, VERIFICATION_ACCOUNT_EMISSIONS_PER_HOUR: 5 };
    const module = await Test.createTestingModule({ imports: [TemporaryConnectionModule, ConfigModule.forRoot({ isGlobal: true, ignoreEnvFile: true, load: [() => settings] }), SimulatorsModule] })
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
  const send = (simulator: Types.ObjectId, body: object = { version: 1, decision: 'Decisión sintética.' }, token = access) =>
    server().post(`/api/v1/simuladores/${simulator}/respuestas`).auth(token, { type: 'bearer' }).send(body);
  const answers = (simulator: Types.ObjectId) => raw('respuestas_simulador').find({ simuladorId: simulator }).toArray();
  const lessonRecords = (lesson: Types.ObjectId, student = user) => raw('progreso_leccion').find({ usuarioId: student, leccionId: lesson }).toArray();

  /** Module 1 with a reading lesson, its simulator lesson and one case. Module 2 stays locked. */
  async function scenario() {
    const course = courseFixture({ titulo: `Curso ${new Types.ObjectId()}` });
    const modules = [1, 2].map((orden) => moduleFixture(course._id, orden));
    const reading = lessonFixture(modules[0]._id, 1);
    const activity = lessonFixture(modules[0]._id, 9, { secciones: [{ tipo: 'recurso', recurso: 'simulador' }] });
    const simulator = simulatorFixture(modules[0]._id), locked = simulatorFixture(modules[1]._id);
    await raw('cursos').insertOne(course); await raw('modulos').insertMany(modules); await raw('lecciones').insertMany([reading, activity]);
    await raw('simuladores').insertMany([simulator, locked]);
    return { course, modules, reading, activity, simulator, locked };
  }

  it('exige autenticación y rol estudiante', async () => {
    const s = await scenario(), path = `simuladores/${s.simulator._id}/respuestas`;
    await server().get(`/api/v1/modulos/${s.modules[0]._id}/simuladores`).expect(401);
    await server().get(`/api/v1/${path}`).expect(401);
    await server().post(`/api/v1/${path}`).send({ version: 1, decision: 'x' }).expect(401);
    await get(path, otherRoleAccess).expect(403);
    await send(s.simulator._id, undefined, otherRoleAccess).expect(403);
    expect(await answers(s.simulator._id)).toHaveLength(0);
  });
  it('muestra el caso sin datos internos ni cabeceras cacheables', async () => {
    const s = await scenario(); await raw('simuladores').updateOne({ _id: s.simulator._id }, { $set: { respuestaGuia: 'privada' } });
    const response = await get(`modulos/${s.modules[0]._id}/simuladores`).expect(200);
    expect(response.body.items).toEqual([{ id: s.simulator._id.toHexString(), titulo: s.simulator.titulo, version: 1, contexto: s.simulator.contexto, consigna: s.simulator.consigna, modo: 'ia_asistida' }]);
    expect(response.headers['cache-control']).toBe('no-store');
  });
  it('guarda pendiente_ia sin retroalimentación y completa la lección del simulador, no las demás', async () => {
    const s = await scenario();
    const response = await send(s.simulator._id).expect(201);
    expect(response.body).toMatchObject({ estadoIA: 'pendiente_ia', decision: 'Decisión sintética.', version: 1 });
    const documents = await answers(s.simulator._id);
    expect(documents).toHaveLength(1);
    expect(Object.keys(documents[0]).sort()).toEqual(['_id', 'cursoId', 'decision', 'estadoIA', 'fecha', 'moduloId', 'simuladorId', 'usuarioId', 'version']);
    expect(documents[0]).toMatchObject({ usuarioId: user, cursoId: s.course._id, moduloId: s.modules[0]._id });
    expect(await lessonRecords(s.activity._id)).toMatchObject([{ estado: 'completada', completadaEn: expect.any(Date) }]);
    expect(await lessonRecords(s.reading._id)).toHaveLength(0);
    expect(await connection.db!.listCollections({ name: 'retroalimentaciones_ia' }).toArray()).toHaveLength(0);
  });
  it('conserva todas las respuestas y la primera fecha de la lección; una posición previa pasa a completada', async () => {
    const s = await scenario();
    await raw('progreso_leccion').insertOne({ usuarioId: user, leccionId: s.activity._id, estado: 'en_progreso', puntoActual: 0, actualizadoEn: new Date(), completadaEn: null });
    await send(s.simulator._id, { version: 1, decision: 'Primera.' }).expect(201);
    const [first] = await lessonRecords(s.activity._id);
    expect(first).toMatchObject({ estado: 'completada' });
    await send(s.simulator._id, { version: 1, decision: 'Segunda.' }).expect(201);
    expect(await lessonRecords(s.activity._id)).toEqual([first]);
    const history = await get(`simuladores/${s.simulator._id}/respuestas?limite=1`).expect(200);
    expect(history.body).toMatchObject({ pagina: 1, limite: 1, hayMas: true, items: [{ decision: 'Segunda.' }] });
    expect(await answers(s.simulator._id)).toHaveLength(2);
  });
  it('cada estudiante ve solo sus respuestas y completa solo su lección', async () => {
    const s = await scenario(), path = `simuladores/${s.simulator._id}/respuestas`;
    await send(s.simulator._id).expect(201);
    expect((await get(path, otherAccess).expect(200)).body.items).toEqual([]);
    expect(await lessonRecords(s.activity._id, other)).toHaveLength(0);
    await send(s.simulator._id, { version: 1, decision: 'x', usuarioId: user.toHexString() }, otherAccess).expect(400);
  });
  it('módulo bloqueado, caso inactivo, versión distinta o cuerpo inválido no escriben nada', async () => {
    const s = await scenario();
    await send(s.locked._id).expect(403); await get(`modulos/${s.modules[1]._id}/simuladores`).expect(403); await get(`simuladores/${s.locked._id}/respuestas`).expect(403);
    await send(s.simulator._id, { version: 2, decision: 'x' }).expect(409);
    for (const body of [{}, { version: 1 }, { decision: 'x' }, { version: 1, decision: '   ' }, { version: 1, decision: 5 }, { version: '1', decision: 'x' }, { version: 1, decision: 'x'.repeat(5001) }, { version: 1, decision: 'x', estadoIA: 'evaluada' }]) await send(s.simulator._id, body).expect(400);
    await send(new Types.ObjectId()).expect(404);
    await raw('simuladores').updateOne({ _id: s.simulator._id }, { $set: { activo: false } });
    await send(s.simulator._id).expect(404);
    expect(await raw('respuestas_simulador').countDocuments({ simuladorId: { $in: [s.simulator._id, s.locked._id] } })).toBe(0);
    expect(await lessonRecords(s.activity._id)).toHaveLength(0);
  });
  it('si no se puede completar la lección, la respuesta tampoco se guarda', async () => {
    const s = await scenario();
    await connection.db!.command({ collMod: 'progreso_leccion', validator: { estado: { $ne: 'completada' } }, validationLevel: 'strict' });
    try {
      const response = await send(s.simulator._id).expect(503);
      expect(response.text).not.toMatch(/Decisión sintética|Mongo|validation/i);
      expect(await answers(s.simulator._id)).toHaveLength(0);
    } finally { await connection.db!.command({ collMod: 'progreso_leccion', validator: {} }); }
    await raw('progreso_leccion').dropIndex('usuarioId_1_leccionId_1');
    try {
      await send(s.simulator._id).expect(503);
      expect(await answers(s.simulator._id)).toHaveLength(0);
    } finally { await installIndex(); }
  });
  it('envíos simultáneos guardan cada respuesta y un solo registro de la lección', async () => {
    const s = await scenario();
    const responses = await Promise.all([1, 2, 3, 4].map((n) => send(s.simulator._id, { version: 1, decision: `Respuesta ${n}.` })));
    expect(responses.map((r) => r.status)).toEqual([201, 201, 201, 201]);
    expect(await answers(s.simulator._id)).toHaveLength(4);
    expect(await lessonRecords(s.activity._id)).toMatchObject([{ estado: 'completada' }]);
  });
  it('no filtra datos internos en las respuestas ni en los registros', async () => {
    const s = await scenario(), response = await send(s.simulator._id).expect(201);
    expect(response.text).not.toMatch(/contraseña|hash|token|usuarioId|_id|__v/i);
    expect(logs.join('\n')).not.toMatch(/Bearer|contraseña|synthetic-private|Decisión sintética/i);
  });
});
