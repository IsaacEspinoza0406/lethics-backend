import { Global, INestApplication, Logger, Module, ServiceUnavailableException } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { getConnectionToken } from '@nestjs/mongoose';
import { Test } from '@nestjs/testing';
import mongoose, { Connection, Types } from 'mongoose';
import { randomBytes } from 'node:crypto';
import request from 'supertest';
import { configureApp } from '../src/configure-app';
import { AccessTokenService } from '../src/infrastructure/security/access-token.service';
import { ModuleProgressPort } from '../src/modules/learning/application/module-progress';
import { LearningModule } from '../src/modules/learning/learning.module';
import { optionalMongoTestScope } from './integration-isolation';
import { courseFixture, lessonFixture, moduleFixture } from './learning-fixtures';

const scope = optionalMongoTestScope(process.env.LETHICS_IDENTITY_TEST_URI, 'ops');
(scope ? describe : describe.skip)('Contenido educativo: MongoDB propio y HTTP; progreso de fixture', () => {
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
    for (const name of ['usuarios', 'cursos', 'modulos', 'lecciones']) await temporary.db.createCollection(name);
    await temporary.db.collection('usuarios').insertMany([{ _id: user, rol: 'estudiante' }, { _id: otherRole, rol: 'no-aprobado' }].map(({ _id, rol }, i) => ({ _id, nombre: 'Sintético', correo: `learning-${i}@example.test`, rol, verificadoEn: new Date(), contraseñaHash: 'synthetic-private-password-hash' })));
    const settings = { NODE_ENV: 'test', AUTH_HTTP_ENABLED: false, JWT_ACCESS_SECRET_BASE64: randomBytes(32).toString('base64'), JWT_ACCESS_ISSUER: 'learning-test', JWT_ACCESS_AUDIENCE: 'learning-test', JWT_ACCESS_TTL_SECONDS: 900,
      VERIFICATION_CODE_HMAC_KEY_BASE64: randomBytes(32).toString('base64'), RATE_LIMIT_HMAC_KEY_BASE64: randomBytes(32).toString('base64'), VERIFICATION_ACCOUNT_FAILURES_PER_HOUR: 20, VERIFICATION_ACCOUNT_EMISSIONS_PER_HOUR: 5 };
    const module = await Test.createTestingModule({ imports: [TemporaryConnectionModule, ConfigModule.forRoot({ isGlobal: true, ignoreEnvFile: true, load: [() => settings] }), LearningModule] })
      .overrideProvider(ModuleProgressPort).useValue(progress).compile();
    app = module.createNestApplication(); configureApp(app); await app.init();
    access = app.get(AccessTokenService).sign(user.toString()); otherRoleAccess = app.get(AccessTokenService).sign(otherRole.toString());
  }, 60000);
  afterAll(async () => {
    try { if (app) await app.close(); } finally { try { await scope?.close(); } finally { try { if (connection) await connection.close(); } finally { spies.forEach((spy) => spy.mockRestore()); } } }
  });
  const get = (path: string, token = access) => request(app.getHttpServer()).get(`/api/v1/${path}`).auth(token, { type: 'bearer' });

  /** A published course with 5 modules; modules 1 and 2 have lessons (inserted in reverse order to prove sorting). */
  async function scenario(courseOverrides = {}) {
    const course = courseFixture({ titulo: `Curso ${new Types.ObjectId()}`, ...courseOverrides });
    const modules = [1, 2, 3, 4, 5].map((orden) => moduleFixture(course._id, orden));
    const lessons = [10, 9, 8, 7, 6, 5, 4, 3, 2, 1].map((orden) => lessonFixture(modules[0]._id, orden));
    const second = [2, 1].map((orden) => lessonFixture(modules[1]._id, orden));
    await raw('cursos').insertOne(course); await raw('modulos').insertMany([...modules].reverse()); await raw('lecciones').insertMany([...lessons, ...second]);
    completed.set(course._id.toHexString(), []);
    return { course, modules, lessons, second };
  }

  it('exige autenticación y rol estudiante en todas las rutas', async () => {
    const s = await scenario();
    const paths = ['cursos', `cursos/${s.course._id}`, `cursos/${s.course._id}/modulos`, `modulos/${s.modules[0]._id}/lecciones`, `lecciones/${s.lessons[0]._id}`];
    for (const path of paths) {
      await request(app.getHttpServer()).get(`/api/v1/${path}`).expect(401);
      await get(path, otherRoleAccess).expect(403);
    }
  });
  it('lista solo cursos publicados, con paginación y sin cabeceras cacheables', async () => {
    const published = await scenario(), draft = await scenario({ estado: 'borrador' });
    const response = await get('cursos?limite=50').expect(200);
    const ids = response.body.items.map((c: { id: string }) => c.id);
    expect(ids).toContain(published.course._id.toHexString()); expect(ids).not.toContain(draft.course._id.toHexString());
    expect(response.body).toMatchObject({ pagina: 1, limite: 50, hayMas: false }); expect(response.headers['cache-control']).toBe('no-store');
    expect(response.body.items[0]).toEqual({ id: expect.any(String), titulo: expect.any(String) });
    const paged = await get('cursos?pagina=1&limite=1').expect(200);
    expect(paged.body.items).toHaveLength(1); expect(paged.body.hayMas).toBe(true);
    await get('cursos?limite=0').expect(400); await get('cursos?pagina=x').expect(400);
  });
  it('detalle de curso con proyecto final; borrador, inexistente o inválido no se exponen', async () => {
    const s = await scenario(), draft = await scenario({ estado: 'borrador' });
    const response = await get(`cursos/${s.course._id}`).expect(200);
    expect(response.body).toEqual({ id: s.course._id.toHexString(), titulo: s.course.titulo, proyectoFinal: s.course.proyectoFinal });
    await get(`cursos/${draft.course._id}`).expect(404); await get(`cursos/${new Types.ObjectId()}`).expect(404); await get('cursos/no-es-id').expect(400);
  });
  it('módulos en orden con los posteriores visibles pero no disponibles', async () => {
    const s = await scenario(), response = await get(`cursos/${s.course._id}/modulos`).expect(200);
    expect(response.body.items.map((m: { orden: number; disponible: boolean }) => [m.orden, m.disponible])).toEqual([[1, true], [2, false], [3, false], [4, false], [5, false]]);
    expect(response.body.items[0]).toEqual({ id: s.modules[0]._id.toHexString(), orden: 1, titulo: s.modules[0].titulo, disponible: true });
    expect(progress.completedModules).toHaveBeenCalledWith(user.toString(), s.course._id.toHexString());
    await get(`cursos/${new Types.ObjectId()}/modulos`).expect(404);
  });
  it('el avance es secuencial: completar el módulo 1 abre solo el 2', async () => {
    const s = await scenario(); completed.set(s.course._id.toHexString(), [s.modules[0]._id.toHexString()]);
    const response = await get(`cursos/${s.course._id}/modulos`).expect(200);
    expect(response.body.items.map((m: { disponible: boolean }) => m.disponible)).toEqual([true, true, false, false, false]);
    await get(`modulos/${s.modules[1]._id}/lecciones`).expect(200);
    await get(`modulos/${s.modules[2]._id}/lecciones`).expect(403);
  });
  it('módulos inactivos no aparecen y un predecesor inactivo no abre el siguiente', async () => {
    const s = await scenario(); await raw('modulos').updateOne({ _id: s.modules[1]._id }, { $set: { activo: false } });
    completed.set(s.course._id.toHexString(), s.modules.map((m) => m._id.toHexString()));
    const response = await get(`cursos/${s.course._id}/modulos`).expect(200);
    expect(response.body.items.map((m: { orden: number; disponible: boolean }) => [m.orden, m.disponible])).toEqual([[1, true], [3, false], [4, true], [5, true]]);
    await get(`modulos/${s.modules[1]._id}/lecciones`).expect(404);
    await get(`modulos/${s.modules[2]._id}/lecciones`).expect(403);
  });
  it('lecciones de un módulo disponible: diez, en orden y sin contenido', async () => {
    const s = await scenario(), response = await get(`modulos/${s.modules[0]._id}/lecciones`).expect(200);
    expect(response.body.items.map((l: { orden: number }) => l.orden)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    expect(response.body).toMatchObject({ moduloId: s.modules[0]._id.toHexString(), cursoId: s.course._id.toHexString() });
    expect(response.body.items[0]).toEqual({ id: expect.any(String), orden: 1, titulo: expect.any(String), version: 1 }); expect(response.text).not.toContain('secciones');
  });
  it('un módulo bloqueado responde 403 en lecciones y en el detalle de lección, sin filtrar contenido', async () => {
    const s = await scenario(); const locked = lessonFixture(s.modules[2]._id, 1, { titulo: 'Contenido bloqueado' }); await raw('lecciones').insertOne(locked);
    for (const path of [`modulos/${s.modules[2]._id}/lecciones`, `lecciones/${locked._id}`]) {
      const response = await get(path).expect(403); expect(response.text).not.toContain('Contenido bloqueado');
    }
  });
  it('detalle de lección con los bloques aprobados y recursos no operativos', async () => {
    const s = await scenario(), response = await get(`lecciones/${s.lessons[9]._id}`).expect(200);
    expect(response.body).toMatchObject({ id: s.lessons[9]._id.toHexString(), moduloId: s.modules[0]._id.toHexString(), cursoId: s.course._id.toHexString(), orden: 1, version: 1 });
    expect(response.body.secciones).toEqual([
      { tipo: 'titulo', texto: 'Objetivo sintético' }, { tipo: 'parrafo', texto: 'Texto sintético de la lección.' }, { tipo: 'lista', ordenada: true, items: ['Primero', 'Segundo'] },
      { tipo: 'tabla', encabezados: ['Columna A', 'Columna B'], filas: [['a1', 'b1'], ['a2', '']] }, { tipo: 'destacado', variante: 'nota', texto: 'Nota sintética.' },
      { tipo: 'recurso', recurso: 'flashcards', operativo: false },
    ]);
    expect(response.headers['cache-control']).toBe('no-store');
  });
  it('lección inactiva, módulo inactivo y curso en borrador responden 404', async () => {
    const s = await scenario(), draft = await scenario({ estado: 'borrador' });
    await raw('lecciones').updateOne({ _id: s.lessons[0]._id }, { $set: { activo: false } });
    await get(`lecciones/${s.lessons[0]._id}`).expect(404);
    expect((await get(`modulos/${s.modules[0]._id}/lecciones`).expect(200)).body.items).toHaveLength(9);
    await get(`lecciones/${draft.lessons[0]._id}`).expect(404); await get(`modulos/${draft.modules[0]._id}/lecciones`).expect(404);
    await raw('modulos').updateOne({ _id: s.modules[0]._id }, { $set: { activo: false } });
    await get(`lecciones/${s.lessons[1]._id}`).expect(404); await get(`modulos/${s.modules[0]._id}/lecciones`).expect(404);
    await get(`lecciones/${new Types.ObjectId()}`).expect(404); await get('lecciones/123').expect(400); await get('modulos/123/lecciones').expect(400);
  });
  it('contenido incompatible o fallo de progreso producen 503 sanitizado', async () => {
    const s = await scenario(), broken = lessonFixture(s.modules[0]._id, 11, { secciones: [{ tipo: 'video', url: 'https://example.test' } as never] }); await raw('lecciones').insertOne(broken);
    const bad = await get(`lecciones/${broken._id}`).expect(503); expect(bad.text).not.toMatch(/video|example\.test|Mongo/i);
    await get(`modulos/${s.modules[0]._id}/lecciones`).expect(503);
    const lonely = await scenario(); completed.delete(lonely.course._id.toHexString());
    await get(`cursos/${lonely.course._id}/modulos`).expect(503);
  });
  it('no filtra secretos ni datos internos en las respuestas ni en los registros', async () => {
    const s = await scenario(), response = await get(`lecciones/${s.lessons[0]._id}`).expect(200);
    expect(response.text).not.toMatch(/contraseña|hash|token|usuarioId|_id|__v/i);
    expect(logs.join('\n')).not.toMatch(/Bearer|contraseña|synthetic-private/i);
  });
});
