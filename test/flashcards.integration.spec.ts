import { Global, INestApplication, Logger, Module, ServiceUnavailableException } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { getConnectionToken } from '@nestjs/mongoose';
import { Test } from '@nestjs/testing';
import mongoose, { Connection, Types } from 'mongoose';
import { randomBytes } from 'node:crypto';
import request from 'supertest';
import { configureApp } from '../src/configure-app';
import { AccessTokenService } from '../src/infrastructure/security/access-token.service';
import { FlashcardsModule } from '../src/modules/flashcards/flashcards.module';
import { ModuleProgressPort } from '../src/modules/module-access/application/module-progress';
import { cardFixture } from './flashcards-fixtures';
import { optionalMongoTestScope } from './integration-isolation';
import { courseFixture, moduleFixture } from './learning-fixtures';

const scope = optionalMongoTestScope(process.env.LETHICS_IDENTITY_TEST_URI, 'ops');
(scope ? describe : describe.skip)('Flashcards: MongoDB propio y HTTP; progreso de fixture', () => {
  let app: INestApplication, connection: Connection, access: string, otherRoleAccess: string;
  const user = new Types.ObjectId(), otherRole = new Types.ObjectId(), completed = new Map<string, string[]>();
  const logs: string[] = [], spies: jest.SpyInstance[] = [];
  const progress = { completedModules: jest.fn(async (_user: string, course: string): Promise<readonly string[]> => {
    void _user; const modules = completed.get(course); if (!modules) throw new ServiceUnavailableException('Progreso de fixture no disponible'); return modules;
  }) };
  @Global()
  @Module({ providers: [{ provide: getConnectionToken(), useFactory: () => connection }], exports: [getConnectionToken()] })
  class TemporaryConnectionModule {}
  const raw = (name: string) => connection.db!.collection(name);
  beforeAll(async () => {
    for (const level of ['log', 'error', 'warn', 'debug', 'verbose'] as const) spies.push(jest.spyOn(Logger.prototype, level).mockImplementation((...values: unknown[]) => { logs.push(values.map(String).join(' ')); }));
    const temporary = await scope!.open(); connection = mongoose.createConnection().setClient(temporary.client);
    // Only approved collections, created in the owned UUID database.
    for (const name of ['usuarios', 'cursos', 'modulos', 'flashcards']) await temporary.db.createCollection(name);
    await temporary.db.collection('usuarios').insertMany([{ _id: user, rol: 'estudiante' }, { _id: otherRole, rol: 'no-aprobado' }].map(({ _id, rol }, i) => ({ _id, nombre: 'Sintético', correo: `flashcards-${i}@example.test`, rol, verificadoEn: new Date(), contraseñaHash: 'synthetic-private-password-hash' })));
    const settings = { NODE_ENV: 'test', AUTH_HTTP_ENABLED: false, JWT_ACCESS_SECRET_BASE64: randomBytes(32).toString('base64'), JWT_ACCESS_ISSUER: 'flashcards-test', JWT_ACCESS_AUDIENCE: 'flashcards-test', JWT_ACCESS_TTL_SECONDS: 900,
      VERIFICATION_CODE_HMAC_KEY_BASE64: randomBytes(32).toString('base64'), RATE_LIMIT_HMAC_KEY_BASE64: randomBytes(32).toString('base64'), VERIFICATION_ACCOUNT_FAILURES_PER_HOUR: 20, VERIFICATION_ACCOUNT_EMISSIONS_PER_HOUR: 5 };
    const module = await Test.createTestingModule({ imports: [TemporaryConnectionModule, ConfigModule.forRoot({ isGlobal: true, ignoreEnvFile: true, load: [() => settings] }), FlashcardsModule] })
      .overrideProvider(ModuleProgressPort).useValue(progress).compile();
    app = module.createNestApplication(); configureApp(app); await app.init();
    access = app.get(AccessTokenService).sign(user.toString()); otherRoleAccess = app.get(AccessTokenService).sign(otherRole.toString());
  }, 60000);
  afterAll(async () => {
    try { if (app) await app.close(); } finally { try { await scope?.close(); } finally { try { if (connection) await connection.close(); } finally { spies.forEach((spy) => spy.mockRestore()); } } }
  });
  const get = (path: string, token = access) => request(app.getHttpServer()).get(`/api/v1/${path}`).auth(token, { type: 'bearer' });

  /** A published course with 5 modules; module 1 has 10 cards (inserted in reverse order to prove sorting), module 2 has 3. */
  async function scenario(courseOverrides = {}) {
    const course = courseFixture({ titulo: `Curso ${new Types.ObjectId()}`, ...courseOverrides });
    const modules = [1, 2, 3, 4, 5].map((orden) => moduleFixture(course._id, orden));
    const first = [10, 9, 8, 7, 6, 5, 4, 3, 2, 1].map((orden) => cardFixture(modules[0]._id, orden)), second = [3, 1, 2].map((orden) => cardFixture(modules[1]._id, orden));
    await raw('cursos').insertOne(course); await raw('modulos').insertMany([...modules].reverse()); await raw('flashcards').insertMany([...first, ...second]);
    completed.set(course._id.toHexString(), []);
    return { course, modules, first, second };
  }

  it('exige autenticación y rol estudiante', async () => {
    const s = await scenario(), path = `modulos/${s.modules[0]._id}/flashcards`;
    await request(app.getHttpServer()).get(`/api/v1/${path}`).expect(401);
    await get(path, otherRoleAccess).expect(403);
  });
  it('devuelve el mazo completo en orden, con concepto y definición, sin cabeceras cacheables', async () => {
    const s = await scenario(), response = await get(`modulos/${s.modules[0]._id}/flashcards`).expect(200);
    expect(response.body).toMatchObject({ moduloId: s.modules[0]._id.toHexString(), cursoId: s.course._id.toHexString() });
    expect(response.body.items.map((c: { orden: number }) => c.orden)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    expect(response.body.items[0]).toEqual({ id: expect.any(String), orden: 1, concepto: 'Concepto sintético 1', definicion: 'Definición sintética 1.' });
    expect(response.headers['cache-control']).toBe('no-store');
  });
  it('un módulo bloqueado responde 403 sin filtrar tarjetas; completar el anterior lo abre', async () => {
    const s = await scenario(), path = `modulos/${s.modules[1]._id}/flashcards`;
    const locked = await get(path).expect(403); expect(locked.text).not.toContain('Concepto sintético');
    completed.set(s.course._id.toHexString(), [s.modules[0]._id.toHexString()]);
    const open = await get(path).expect(200); expect(open.body.items.map((c: { orden: number }) => c.orden)).toEqual([1, 2, 3]);
    await get(`modulos/${s.modules[2]._id}/flashcards`).expect(403);
  });
  it('un módulo abierto sin tarjetas devuelve un mazo vacío', async () => {
    const s = await scenario(); await raw('flashcards').deleteMany({ moduloId: s.modules[0]._id });
    expect((await get(`modulos/${s.modules[0]._id}/flashcards`).expect(200)).body.items).toEqual([]);
  });
  it('módulo inactivo, curso en borrador, inexistente o identificador inválido', async () => {
    const s = await scenario(), draft = await scenario({ estado: 'borrador' });
    await get(`modulos/${draft.modules[0]._id}/flashcards`).expect(404);
    await raw('modulos').updateOne({ _id: s.modules[0]._id }, { $set: { activo: false } });
    await get(`modulos/${s.modules[0]._id}/flashcards`).expect(404);
    await get(`modulos/${new Types.ObjectId()}/flashcards`).expect(404); await get('modulos/123/flashcards').expect(400);
  });
  it('una tarjeta incompatible o un fallo de progreso producen 503 sanitizado', async () => {
    const s = await scenario(); await raw('flashcards').insertOne({ ...cardFixture(s.modules[0]._id, 11), definicion: '' });
    const bad = await get(`modulos/${s.modules[0]._id}/flashcards`).expect(503); expect(bad.text).not.toMatch(/Concepto sintético|Mongo/i);
    const lonely = await scenario(); completed.delete(lonely.course._id.toHexString());
    await get(`modulos/${lonely.modules[1]._id}/flashcards`).expect(503);
    // El módulo 1 siempre está abierto: su mazo no depende del progreso.
    expect((await get(`modulos/${lonely.modules[0]._id}/flashcards`).expect(200)).body.items).toHaveLength(10);
  });
  it('un orden de módulo repetido produce 503 sin entregar tarjetas, también en el módulo 1', async () => {
    const s = await scenario(); await raw('modulos').insertOne(moduleFixture(s.course._id, 1));
    const response = await get(`modulos/${s.modules[0]._id}/flashcards`).expect(503); expect(response.text).not.toMatch(/Concepto sintético|Mongo/i);
  });
  it('no filtra secretos ni datos internos en las respuestas ni en los registros', async () => {
    const s = await scenario(), response = await get(`modulos/${s.modules[0]._id}/flashcards`).expect(200);
    expect(response.text).not.toMatch(/contraseña|hash|token|usuarioId|_id|__v/i);
    expect(logs.join('\n')).not.toMatch(/Bearer|contraseña|synthetic-private/i);
  });
});
