import { Global, INestApplication, Logger, Module, ServiceUnavailableException } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { getConnectionToken } from '@nestjs/mongoose';
import { Test } from '@nestjs/testing';
import mongoose, { Connection, Types } from 'mongoose';
import { randomBytes, randomUUID } from 'node:crypto';
import request from 'supertest';
import { configureApp } from '../src/configure-app';
import { AccessTokenService } from '../src/infrastructure/security/access-token.service';
import { AssessmentsModule } from '../src/modules/assessments/assessments.module';
import { AssessmentProgressPort, UnintegratedAssessmentProgress } from '../src/modules/assessments/application/project-assessment-context';
import { FinalExamContext } from '../src/modules/assessments/application/assessment-context';
import { Evaluation } from '../src/modules/assessments/domain/assessment';
import { ProjectSubmission, submissionSlot } from '../src/modules/projects/domain/project';
import { CourseProject, ProjectCoursePort, ProjectFilePort, ProjectOwner, ProjectSubmissionPort, UnconfiguredProjectFiles, VerifiedProjectFile } from '../src/modules/projects/application/project-ports';
import { ProjectsService } from '../src/modules/projects/application/projects.service';
import { optionalMongoTestScope } from './integration-isolation';
import { assessmentFixture } from './assessment-fixtures';
import { projectFixture } from './project-fixtures';

const scope = optionalMongoTestScope(process.env.LETHICS_IDENTITY_TEST_URI, 'ops');
(scope ? describe : describe.skip)('Entregas: MongoDB propio, HTTP y puente A2; cursos/progreso/archivos de fixture', () => {
  let app: INestApplication, connection: Connection, access: string, otherAccess: string;
  const user = new Types.ObjectId(), other = new Types.ObjectId(), definitions = new Map<string, CourseProject>();
  const fileFixtures = new Map<string, VerifiedProjectFile>(), completed = new Map<string, string[]>();
  const logs: string[] = [], spies: jest.SpyInstance[] = [];
  const courses = { describe: jest.fn(async (owner: Readonly<ProjectOwner>) => [user.toString(), other.toString()].includes(owner.usuarioId) ? definitions.get(owner.cursoId) ?? null : null) };
  const files = { verify: jest.fn(async (_owner: Readonly<ProjectOwner>, reference: string) => { void _owner; return fileFixtures.get(reference) ?? null; }) };
  const progress = { isQuizAvailable: jest.fn(async () => false), completedModules: jest.fn(async (input: Readonly<FinalExamContext>): Promise<{ cursoId: string; modulosCompletados: readonly string[] }> => {
    const modules = completed.get(input.cursoId); if (!modules) throw new ServiceUnavailableException('Progreso de fixture no disponible');
    return { cursoId: input.cursoId, modulosCompletados: modules };
  }) };
  @Global()
  @Module({ providers: [{ provide: getConnectionToken(), useFactory: () => connection }], exports: [getConnectionToken()] })
  class TemporaryConnectionModule {}
  const Model = () => connection.model<ProjectSubmission>('EntregaProyecto');
  const raw = () => connection.db!.collection('entregas_proyecto');
  beforeAll(async () => {
    for (const level of ['log', 'error', 'warn', 'debug', 'verbose'] as const) spies.push(jest.spyOn(Logger.prototype, level).mockImplementation((...values: unknown[]) => { logs.push(values.map(String).join(' ')); }));
    const temporary = await scope!.open(); connection = mongoose.createConnection().setClient(temporary.client);
    // Only approved collections; course/progress/file fixtures never create their collections.
    for (const name of ['usuarios', 'evaluaciones', 'intentos_evaluacion', 'entregas_proyecto']) await temporary.db.createCollection(name);
    await temporary.db.collection('usuarios').insertMany([user, other].map((_id, i) => ({ _id, nombre: 'Sintético', correo: `project-${i}@example.test`, rol: 'estudiante', verificadoEn: new Date(), contraseñaHash: 'synthetic-private-password-hash' })));
    const settings = { NODE_ENV: 'test', AUTH_HTTP_ENABLED: false, JWT_ACCESS_SECRET_BASE64: randomBytes(32).toString('base64'), JWT_ACCESS_ISSUER: 'projects-test', JWT_ACCESS_AUDIENCE: 'projects-test', JWT_ACCESS_TTL_SECONDS: 900,
      VERIFICATION_CODE_HMAC_KEY_BASE64: randomBytes(32).toString('base64'), RATE_LIMIT_HMAC_KEY_BASE64: randomBytes(32).toString('base64'), VERIFICATION_ACCOUNT_FAILURES_PER_HOUR: 20, VERIFICATION_ACCOUNT_EMISSIONS_PER_HOUR: 5 };
    const module = await Test.createTestingModule({ imports: [TemporaryConnectionModule, ConfigModule.forRoot({ isGlobal: true, ignoreEnvFile: true, load: [() => settings] }), AssessmentsModule] })
      .overrideProvider(ProjectCoursePort).useValue(courses).overrideProvider(ProjectFilePort).useValue(files).overrideProvider(AssessmentProgressPort).useValue(progress).compile();
    app = module.createNestApplication(); configureApp(app); await app.init();
    await Model().createIndexes(); await connection.model('IntentoEvaluacion').createIndexes(); // Owned UUID DB only.
    access = app.get(AccessTokenService).sign(user.toString()); otherAccess = app.get(AccessTokenService).sign(other.toString());
  }, 20000);
  afterAll(async () => {
    try { if (app) await app.close(); } finally { try { await scope?.close(); } finally { try { if (connection) await connection.close(); } finally { spies.forEach((spy) => spy.mockRestore()); } } }
  });
  const get = (path: string, token = access) => request(app.getHttpServer()).get(`/api/v1/${path}`).auth(token, { type: 'bearer' });
  const body = (solicitudId = randomUUID()) => ({ solicitudId, evidencias: [{ tipo: 'enlace' as const, url: 'https://example.test/project' }] });
  function scenario() {
    const course = new Types.ObjectId(), definition = projectFixture(course.toString()); definitions.set(course.toString(), definition);
    completed.set(course.toString(), Array.from({ length: 5 }, () => new Types.ObjectId().toString()));
    const path = `cursos/${course}/entregas-proyecto`;
    return { course, definition, path, submit: (input: object = body(), token = access) => request(app.getHttpServer()).post(`/api/v1/${path}`).auth(token, { type: 'bearer' }).send(input) };
  }
  function fileFixture(course: Types.ObjectId, owner = user) {
    const file = { usuarioId: owner.toString(), cursoId: course.toString(), referencia: `file_${randomUUID()}`, nombre: 'evidencia.pdf', mime: 'application/pdf', bytes: 1024, sha256: 'a'.repeat(64) };
    fileFixtures.set(file.referencia, file); return file;
  }
  it('consulta instrucciones y política autoritativa del curso', async () => {
    const s = scenario(), response = await get(`cursos/${s.course}/proyecto`).expect(200);
    expect(response.body).toEqual(s.definition); expect(response.headers['cache-control']).toBe('no-store');
    expect(courses.describe).toHaveBeenCalledWith({ usuarioId: user.toString(), cursoId: s.course.toString() });
    await get(`cursos/${new Types.ObjectId()}/proyecto`).expect(404);
  });
  it('registra enlace permitido con identidad y fecha del servidor', async () => {
    const s = scenario(), input = body(), response = await s.submit(input).expect(201);
    expect(response.body).toMatchObject({ cursoId: s.course.toString(), solicitudId: input.solicitudId, estado: 'registrada', evidencias: input.evidencias });
    expect(response.body.id).toBe(submissionSlot(user, s.course, 1).toHexString());
    const stored = await raw().findOne({ _id: new Types.ObjectId(response.body.id) });
    expect(stored!.usuarioId).toEqual(user); expect(stored!.fechaEntrega).toBeInstanceOf(Date);
    expect(response.text).not.toMatch(/usuarioId|contraseña|sha256|token|referencia/);
    expect(await app.get(ProjectSubmissionPort).hasValidSubmission(user.toString(), s.course.toString())).toBe(true);
    expect(await app.get(ProjectSubmissionPort).hasValidSubmission(other.toString(), s.course.toString())).toBe(false);
  });
  it('exige autenticación, correo verificado y rol aprobado', async () => {
    const s = scenario(); await request(app.getHttpServer()).post(`/api/v1/${s.path}`).send(body()).expect(401);
    await request(app.getHttpServer()).get(`/api/v1/${s.path}`).expect(401);
    for (const [rol, verificadoEn, status] of [['no-aprobado', new Date(), 403], ['estudiante', null, 401]] as const) {
      const _id = new Types.ObjectId(); await connection.db!.collection('usuarios').insertOne({ _id, nombre: 'Sintético', correo: `${_id}@example.test`, rol, verificadoEn });
      await s.submit(body(), app.get(AccessTokenService).sign(_id.toString())).expect(status);
    }
  });
  it('rechaza curso incorrecto e indicadores de validez/identidad del frontend', async () => {
    const unknown = new Types.ObjectId(); await request(app.getHttpServer()).post(`/api/v1/cursos/${unknown}/entregas-proyecto`).auth(access, { type: 'bearer' }).send(body()).expect(404);
    const s = scenario();
    for (const field of ['usuarioId', 'cursoId', 'estado', 'valida', 'fechaEntrega']) await s.submit({ ...body(), [field]: true }).expect(400);
    await get(s.path).query({ usuarioId: other.toString() }).expect(400);
    await get(s.path).query({ limite: 51 }).expect(400);
  });
  it.each(['vacía', 'duplicada', 'http', 'host', 'mixta', 'metadatos'] as const)('evidencia %s no registra entrega', async (kind) => {
    const s = scenario(), input: { solicitudId: string; evidencias: unknown[] } = body();
    if (kind === 'vacía') input.evidencias = [];
    if (kind === 'duplicada') input.evidencias.push(input.evidencias[0]);
    if (kind === 'http') input.evidencias = [{ tipo: 'enlace', url: 'http://example.test/project' }];
    if (kind === 'host') input.evidencias = [{ tipo: 'enlace', url: 'https://not-allowed.example.test/project' }];
    if (kind === 'mixta') input.evidencias = [{ tipo: 'enlace', url: 'https://example.test/project', referencia: 'fake' }];
    if (kind === 'metadatos') input.evidencias = [{ tipo: 'archivo', referencia: 'fake', mime: 'application/pdf', bytes: 1 }];
    await s.submit(input).expect(400); expect(await raw().countDocuments({ cursoId: s.course })).toBe(0);
  });
  it('aplica solo los límites explícitos de la política de fixture, no valores globales inventados', async () => {
    const s = scenario(); s.definition.politica.maxEnlaces = 1; s.definition.politica.maxEntregas = 1;
    await s.submit({ solicitudId: randomUUID(), evidencias: [{ tipo: 'enlace', url: 'https://example.test/a' }, { tipo: 'enlace', url: 'https://example.test/b' }] }).expect(400);
    await s.submit().expect(201); await s.submit().expect(403);
    const different = scenario(); different.definition.politica.maxEntregas = 4;
    for (let i = 0; i < 4; i++) await different.submit().expect(201);
  });
  it('mantiene historial de reentregas sin sobrescribir y devuelve paginación propia', async () => {
    const s = scenario(), first = await s.submit().expect(201), second = await s.submit().expect(201), third = await s.submit().expect(201);
    expect(new Set([first.body.id, second.body.id, third.body.id]).size).toBe(3); await s.submit().expect(403);
    const history = await get(s.path).query({ limite: 2 }).expect(200); expect(history.body.items).toHaveLength(2); expect(history.body.hayMas).toBe(true);
    const last = await get(s.path).query({ limite: 2, pagina: 2 }).expect(200); expect(last.body.items).toHaveLength(1); expect(last.body.hayMas).toBe(false);
    expect((await get(`entregas-proyecto/${first.body.id}`).expect(200)).body).toEqual(first.body);
    await expect(Model().updateOne({ _id: first.body.id }, { $set: { estado: 'otro' } })).rejects.toThrow('inmutable');
  });
  it('privacidad: una entrega ajena no se consulta y el historial no mezcla estudiantes/cursos', async () => {
    const s = scenario(), a = await s.submit().expect(201), b = await s.submit(body(), otherAccess).expect(201);
    await get(`entregas-proyecto/${b.body.id}`).expect(404); await get(`entregas-proyecto/${a.body.id}`, otherAccess).expect(404);
    await get(`entregas-proyecto/${new Types.ObjectId()}`).expect(404);
    expect((await get(s.path).expect(200)).body.items.map((e: { id: string }) => e.id)).toEqual([a.body.id]);
    expect((await get(scenario().path).expect(200)).body.items).toEqual([]);
  });
  it('replay técnico conserva la entrega tras agotar cupos, y rechaza cambiar payload o curso', async () => {
    const s = scenario(); s.definition.politica.maxEntregas = 1;
    const input = body(), first = await s.submit(input).expect(201);
    expect((await s.submit(input).expect(201)).body).toEqual(first.body);
    await s.submit({ ...input, evidencias: [{ tipo: 'enlace', url: 'https://example.test/different' }] }).expect(409);
    await scenario().submit(input).expect(409); expect(await raw().countDocuments({ cursoId: s.course })).toBe(1);
  });
  it('solicitudId concurrente devuelve una sola entrega', async () => {
    const s = scenario(), input = body(), results = await Promise.all(Array.from({ length: 6 }, () => s.submit(input)));
    expect(results.map((r) => r.status)).toEqual(Array(6).fill(201)); expect(new Set(results.map((r) => r.body.id)).size).toBe(1);
    expect(await raw().countDocuments({ cursoId: s.course })).toBe(1);
  }, 20000);
  it('última reentrega concurrente entre instancias conserva el límite', async () => {
    const s = scenario(); await s.submit().expect(201); await s.submit().expect(201);
    const independent = new ProjectsService(connection, Model(), courses, files);
    const results = await Promise.all([s.submit(), s.submit(), independent.submit(user.toString(), s.course.toString(), body()).then(() => ({ status: 201 }), (e: { getStatus(): number }) => ({ status: e.getStatus() }))]);
    expect(results.map((r) => r.status).sort()).toEqual([201, 403, 403]); expect(await raw().countDocuments({ cursoId: s.course })).toBe(3);
  }, 20000);
  it('archivo solo usa prueba del almacenamiento: guarda metadatos confiables y no expone referencia/hash', async () => {
    const s = scenario(), file = fileFixture(s.course), response = await s.submit({ solicitudId: randomUUID(), evidencias: [{ tipo: 'archivo', referencia: file.referencia }] }).expect(201);
    expect(response.body.evidencias).toEqual([{ tipo: 'archivo', nombre: file.nombre, mime: file.mime, bytes: file.bytes }]);
    expect(response.text).not.toMatch(/sha256|referencia/); expect(response.text).not.toContain(file.sha256);
    const [types] = await raw().aggregate([{ $match: { _id: new Types.ObjectId(response.body.id) } }, { $project: { tipo: { $type: { $arrayElemAt: ['$evidencias.bytes', 0] } } } }]).toArray();
    expect(types.tipo).toBe('int');
  });
  it.each(['no recibido', 'dueño', 'curso', 'tamaño', 'formato'] as const)('rechaza archivo: %s conforme a evidencia/política de fixture', async (kind) => {
    const s = scenario(), file = fileFixture(s.course);
    if (kind === 'no recibido') fileFixtures.delete(file.referencia);
    if (kind === 'dueño') file.usuarioId = other.toString();
    if (kind === 'curso') file.cursoId = new Types.ObjectId().toString();
    if (kind === 'tamaño') file.bytes = s.definition.politica.maxArchivoBytes + 1;
    if (kind === 'formato') file.mime = 'application/octet-stream';
    await s.submit({ solicitudId: randomUUID(), evidencias: [{ tipo: 'archivo', referencia: file.referencia }] }).expect(400);
    expect(await raw().countDocuments({ cursoId: s.course })).toBe(0);
  });
  it('fallo del almacenamiento o adaptador ausente no considera entregado un archivo', async () => {
    const s = scenario();
    files.verify.mockImplementationOnce((owner, reference) => new UnconfiguredProjectFiles().verify(owner, reference));
    const response = await s.submit({ solicitudId: randomUUID(), evidencias: [{ tipo: 'archivo', referencia: 'unreceived' }] }).expect(503);
    expect(response.text).not.toContain('Almacenamiento'); expect(await app.get(ProjectSubmissionPort).hasValidSubmission(user.toString(), s.course.toString())).toBe(false);
    files.verify.mockRejectedValueOnce(new Error('synthetic-private-storage'));
    const failure = await s.submit({ solicitudId: randomUUID(), evidencias: [{ tipo: 'archivo', referencia: 'unreceived' }] }).expect(503);
    expect(failure.text + logs.join('\n')).not.toContain('synthetic-private-storage');
  });
  it('curso/política no configurados fallan cerrado sin persistir', async () => {
    const s = scenario();
    courses.describe.mockRejectedValueOnce(new Error('synthetic-private-course'));
    await s.submit().expect(503);
    s.definition.politica.maxEntregas = undefined as never; await s.submit().expect(503);
    expect(await raw().countDocuments({ cursoId: s.course })).toBe(0);
  });
  it('MongoDB fallido no entrega éxito, conserva idempotencia y permite reintentar', async () => {
    const s = scenario(), input = body(), spy = jest.spyOn(Model(), 'create').mockRejectedValueOnce(new Error('synthetic-private-mongo'));
    try { const response = await s.submit(input).expect(503); expect(response.text + logs.join('\n')).not.toContain('synthetic-private-mongo'); } finally { spy.mockRestore(); }
    expect(await raw().countDocuments({ cursoId: s.course })).toBe(0); await s.submit(input).expect(201);
    const read = jest.spyOn(Model(), 'findOne').mockImplementationOnce(() => { throw new Error('synthetic-private-read'); });
    try { await expect(app.get(ProjectSubmissionPort).hasValidSubmission(user.toString(), s.course.toString())).rejects.toThrow('Proyectos no disponibles'); } finally { read.mockRestore(); }
  });
  it('índice ausente bloquea escrituras sin instalarlo automáticamente', async () => {
    const s = scenario(), index = 'usuarioId_1_solicitudId_1'; await Model().collection.dropIndex(index);
    try { await s.submit().expect(503); expect((await Model().collection.indexes()).some((i) => i.name === index)).toBe(false); }
    finally { await Model().createIndexes(); }
  });
  it('A2 consume entrega real mediante puerto: no basta progreso solo ni entrega sola', async () => {
    const s = scenario(), exam = await connection.model<Evaluation>('Evaluacion').create(assessmentFixture({ cursoId: s.course, moduloId: null, tipo: 'examen_final' }));
    const path = `evaluaciones/${exam._id}`, query = { cursoId: s.course.toString() };
    await get(path).query(query).expect(403); await s.submit().expect(201);
    await get(path).query(query).expect(200);
    completed.set(s.course.toString(), []); await get(path).query(query).expect(403);
    progress.completedModules.mockImplementationOnce((input) => new UnintegratedAssessmentProgress().completedModules(input));
    await get(path).query(query).expect(503);
    completed.set(s.course.toString(), Array.from({ length: 5 }, () => new Types.ObjectId().toString()));
    const lookup = jest.spyOn(Model(), 'findOne').mockImplementationOnce(() => { throw new Error('synthetic-private-delivery-read'); });
    try { await get(path).query(query).expect(503); } finally { lookup.mockRestore(); }
    expect(logs.join('\n')).not.toContain(access); expect(logs.join('\n')).not.toContain('synthetic-private-password-hash');
  });
});
