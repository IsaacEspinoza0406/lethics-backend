import { Global, INestApplication, Logger, Module, ServiceUnavailableException } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { getConnectionToken } from '@nestjs/mongoose';
import { Test } from '@nestjs/testing';
import mongoose, { Connection, Types } from 'mongoose';
import { randomBytes, randomUUID } from 'node:crypto';
import request from 'supertest';
import { configureApp } from '../src/configure-app';
import { AssessmentsModule } from '../src/modules/assessments/assessments.module';
import { AssessmentContext, AssessmentContextPort, AssessmentResultsPort, FinalExamContext, FinalExamEligibility } from '../src/modules/assessments/application/assessment-context';
import { finalAttemptId } from '../src/modules/assessments/domain/final-exam';
import { AssessmentsService } from '../src/modules/assessments/application/assessments.service';
import { AccessTokenService } from '../src/infrastructure/security/access-token.service';
import { Attempt, Evaluation } from '../src/modules/assessments/domain/assessment';
import { optionalMongoTestScope } from './integration-isolation';
import { assessmentAnswers, assessmentFixture } from './assessment-fixtures';

const scope = optionalMongoTestScope(process.env.LETHICS_IDENTITY_TEST_URI, 'ops');
(scope ? describe : describe.skip)('Evaluaciones HTTP: MongoDB UUID propio, guards reales y contexto educativo de fixture', () => {
  let app: INestApplication, connection: Connection, published: string, draft: string, final: string;
  let access: string, secondAccess: string;
  const user = new Types.ObjectId(), secondUser = new Types.ObjectId(), course = new Types.ObjectId(), moduleId = new Types.ObjectId();
  const logs: string[] = [], spies: jest.SpyInstance[] = [];
  // No course/module/progress models or collections: this is a contract fixture, not real integration.
  const eligibilityFixtures = new Map<string, FinalExamEligibility>();
  const context = {
    isAvailable: jest.fn(async (input: Readonly<AssessmentContext>) => input.cursoId === course.toString() && input.moduloId === moduleId.toString() && [user.toString(), secondUser.toString()].includes(input.usuarioId)),
    finalExamEligibility: jest.fn(async (input: Readonly<FinalExamContext>) => {
      const fixture = eligibilityFixtures.get(input.cursoId);
      if (!fixture || ![user.toString(), secondUser.toString()].includes(input.usuarioId)) throw new ServiceUnavailableException('Fixture de elegibilidad no disponible');
      return fixture;
    }),
  };
  @Global()
  @Module({ providers: [{ provide: getConnectionToken(), useFactory: () => connection }], exports: [getConnectionToken()] })
  class TemporaryConnectionModule {}

  const EvaluationModel = () => connection.model<Evaluation>('Evaluacion');
  const AttemptModel = () => connection.model<Attempt>('IntentoEvaluacion');
  const rawAttempts = () => connection.db!.collection('intentos_evaluacion');
  const fixture = (patch: Partial<Evaluation> = {}) => assessmentFixture({ cursoId: course, moduloId: moduleId, ...patch });
  beforeAll(async () => {
    for (const level of ['log', 'error', 'warn', 'debug', 'verbose'] as const) spies.push(jest.spyOn(Logger.prototype, level).mockImplementation((...values: unknown[]) => { logs.push(values.map(String).join(' ')); }));
    const temporary = await scope!.open(); connection = mongoose.createConnection().setClient(temporary.client);
    for (const name of ['usuarios', 'evaluaciones', 'intentos_evaluacion']) await temporary.db.createCollection(name);
    await temporary.db.collection('usuarios').insertMany([user, secondUser].map((_id, index) => ({ _id, nombre: 'Sintético', correo: `assessment-${index}@example.test`, rol: 'estudiante', verificadoEn: new Date(), contraseñaHash: 'synthetic-private-hash' })));
    const settings = { NODE_ENV: 'test', AUTH_HTTP_ENABLED: false,
      JWT_ACCESS_SECRET_BASE64: randomBytes(32).toString('base64'), JWT_ACCESS_ISSUER: 'assessments-test', JWT_ACCESS_AUDIENCE: 'assessments-test', JWT_ACCESS_TTL_SECONDS: 900,
      VERIFICATION_CODE_HMAC_KEY_BASE64: randomBytes(32).toString('base64'), RATE_LIMIT_HMAC_KEY_BASE64: randomBytes(32).toString('base64'), VERIFICATION_ACCOUNT_FAILURES_PER_HOUR: 20, VERIFICATION_ACCOUNT_EMISSIONS_PER_HOUR: 5 };
    const module = await Test.createTestingModule({ imports: [TemporaryConnectionModule, ConfigModule.forRoot({ isGlobal: true, ignoreEnvFile: true, load: [() => settings] }), AssessmentsModule] })
      .overrideProvider(AssessmentContextPort).useValue(context).compile();
    app = module.createNestApplication(); configureApp(app); await app.init();
    await AttemptModel().createIndexes(); // Only the owned UUID database; no real index installation.
    published = (await EvaluationModel().create(fixture()))._id.toString();
    draft = (await EvaluationModel().create(fixture({ estado: 'borrador' })))._id.toString();
    final = (await EvaluationModel().create(fixture({ tipo: 'examen_final', moduloId: null })))._id.toString();
    access = app.get(AccessTokenService).sign(user.toString()); secondAccess = app.get(AccessTokenService).sign(secondUser.toString());
  }, 20000);
  beforeEach(() => { context.isAvailable.mockClear(); context.finalExamEligibility.mockClear(); });
  afterAll(async () => {
    try { if (app) await app.close(); } finally { try { await scope?.close(); } finally { try { if (connection) await connection.close(); } finally { spies.forEach((spy) => spy.mockRestore()); } } }
  });
  const get = (path: string, token = access) => request(app.getHttpServer()).get(`/api/v1/${path}`).auth(token, { type: 'bearer' });
  const body = (correct = 7, solicitudId = randomUUID()) => ({ version: 1, solicitudId, respuestas: assessmentAnswers(correct) });
  const submit = (input = body(), evaluation = published, token = access) => request(app.getHttpServer()).post(`/api/v1/evaluaciones/${evaluation}/intentos`).auth(token, { type: 'bearer' }).send(input);

  it('lee publicado y filtra por módulo sin exponer claves ni campos internos', async () => {
    const result = await get(`evaluaciones/${published}`).expect(200);
    expect(result.body.id).toBe(published); expect(result.body.version).toBe(1); expect(result.body.preguntas).toHaveLength(10);
    expect(Object.keys(result.body.preguntas[0]).sort()).toEqual(['id', 'opciones', 'texto']);
    expect(result.text).not.toMatch(/opcionCorrectaId|explicacion|synthetic-private/); expect(result.headers['cache-control']).toBe('no-store');
    expect(context.isAvailable).toHaveBeenCalledWith({ usuarioId: user.toString(), evaluacionId: published, cursoId: course.toString(), moduloId: moduleId.toString(), version: 1 });
    const list = await get('evaluaciones').query({ moduloId: moduleId.toString() }).expect(200);
    expect(list.body.items.map((item: { id: string }) => item.id)).toEqual([published]); expect(list.text).not.toContain('opcionCorrectaId');
  });
  it.each(['draft', 'missing'] as const)('no publica ni permite intentar: %s', async (kind) => {
    const id = kind === 'draft' ? draft : new Types.ObjectId().toString();
    await get(`evaluaciones/${id}`).expect(404); await submit(body(), id).expect(404);
    expect(context.isAvailable).not.toHaveBeenCalled();
  });
  it('examen final exige curso explícito y dependencia educativa disponible', async () => {
    await get(`evaluaciones/${final}`).expect(400); await submit(body(), final).expect(400);
    await get(`evaluaciones/${final}`).query({ cursoId: course.toString() }).expect(503);
  });
  it('respeta disponibilidad del alumno y falla cerrado si falta la integración', async () => {
    context.isAvailable.mockResolvedValueOnce(false); await get(`evaluaciones/${published}`).expect(404);
    context.isAvailable.mockResolvedValueOnce(false); await submit().expect(404);
    context.isAvailable.mockRejectedValueOnce(new ServiceUnavailableException('Integración pendiente'));
    const unavailable = await get(`evaluaciones/${published}`).expect(503); expect(unavailable.text).not.toContain('Integración pendiente');
  });
  it('califica 70% como aprobado y preserva cada intento legítimo sin sobrescribir', async () => {
    const first = await submit(body(7)).expect(201), second = await submit(body(6)).expect(201), third = await submit(body(10)).expect(201);
    expect(first.body).toMatchObject({ aciertos: 7, total: 10, porcentaje: 70, aprobado: true, evaluacionId: published, version: 1 });
    expect(second.body).toMatchObject({ porcentaje: 60, aprobado: false }); expect(third.body.porcentaje).toBe(100);
    expect(new Set([first.body.id, second.body.id, third.body.id]).size).toBe(3);
    const stored = (await rawAttempts().findOne({ _id: new Types.ObjectId(first.body.id) }))!;
    expect(stored.usuarioId).toEqual(user); expect(stored.cursoId).toEqual(course); expect(stored.moduloId).toEqual(moduleId);
    expect(stored.fecha).toBeInstanceOf(Date); expect(stored.respuestas).toHaveLength(10);
    const [types] = await rawAttempts().aggregate([{ $match: { _id: stored._id } }, { $project: { _id: 0, version: { $type: '$version' }, total: { $type: '$total' }, aciertos: { $type: '$aciertos' }, porcentaje: { $type: '$porcentaje' } } }]).toArray();
    expect(types).toEqual({ version: 'int', total: 'int', aciertos: 'int', porcentaje: 'double' });
    expect(first.text).not.toMatch(/opcionCorrectaId|usuarioId|contraseñaHash/);
  });
  it.each(['incomplete', 'duplicate', 'question', 'option'] as const)('rechaza envío %s sin crear intento', async (kind) => {
    const input = body(), before = await rawAttempts().countDocuments();
    if (kind === 'incomplete') input.respuestas.pop();
    if (kind === 'duplicate') input.respuestas[1] = input.respuestas[0];
    if (kind === 'question') input.respuestas[0].preguntaId = 'unknown';
    if (kind === 'option') input.respuestas[0].opcionId = 'unknown';
    const result = await submit(input).expect(400); expect(result.text).not.toContain('opcionCorrectaId');
    expect(await rawAttempts().countDocuments()).toBe(before);
  });
  it('DTO rechaza calificación, identidad y parámetros arbitrarios', async () => {
    for (const field of ['usuarioId', 'porcentaje', 'aprobado', 'aciertos']) await submit({ ...body(), [field]: field === 'usuarioId' ? secondUser.toString() : 100 }).expect(400);
    await submit({ ...body(), respuestas: Array(51).fill(assessmentAnswers()[0]) }).expect(400);
    await get('intentos-evaluacion').query({ usuarioId: secondUser.toString() }).expect(400);
    await get('intentos-evaluacion').query({ limite: 51 }).expect(400);
    await get('intentos-evaluacion').query({ orden: '$where' }).expect(400);
    await get('evaluaciones').query({ moduloId: 'invalid' }).expect(400);
    await get('evaluaciones/not-an-objectid').expect(400);
  });
  it('reintento técnico devuelve el mismo intento aun con orden de respuestas distinto', async () => {
    const input = body(), first = await submit(input).expect(201);
    const next = await submit({ ...input, respuestas: [...input.respuestas].reverse() }).expect(201);
    expect(next.body).toEqual(first.body); expect(await rawAttempts().countDocuments({ usuarioId: user, solicitudId: input.solicitudId })).toBe(1);
  });
  it('reutilizar solicitudId con otra evaluación, versión o respuesta produce conflicto', async () => {
    const input = body(); await submit(input).expect(201);
    await submit({ ...input, version: 2 }).expect(409); await submit({ ...input, respuestas: assessmentAnswers(6) }).expect(409);
    await submit(input, draft).expect(409);
    expect(await rawAttempts().countDocuments({ usuarioId: user, solicitudId: input.solicitudId })).toBe(1);
  });
  it('concurrencia idempotente mantiene una sola escritura', async () => {
    const input = body(), responses = await Promise.all(Array.from({ length: 6 }, () => submit(input)));
    expect(responses.map((result) => result.status)).toEqual(Array(6).fill(201)); expect(new Set(responses.map((result) => result.body.id)).size).toBe(1);
    expect(await rawAttempts().countDocuments({ usuarioId: user, solicitudId: input.solicitudId })).toBe(1);
  }, 15000);
  it('concurrencia con solicitudId compartido y payload diferente admite solo uno', async () => {
    const input = body(), results = await Promise.all([submit(input), submit({ ...input, respuestas: assessmentAnswers(6) })]);
    expect(results.map((result) => result.status).sort()).toEqual([201, 409]);
  });
  it('mismo solicitudId entre alumnos no mezcla identidades', async () => {
    const input = body(), first = await submit(input).expect(201), second = await submit(input, published, secondAccess).expect(201);
    expect(first.body.id).not.toBe(second.body.id);
    expect(await rawAttempts().countDocuments({ solicitudId: input.solicitudId })).toBe(2);
  });
  it('intentos legítimos concurrentes se conservan por separado', async () => {
    const input = [body(), body()], responses = await Promise.all(input.map((value) => submit(value)));
    expect(responses.map((result) => result.status)).toEqual([201, 201]); expect(responses[0].body.id).not.toBe(responses[1].body.id);
  });
  it('preserva versión histórica y rechaza versión incorrecta sin alterar la calificación previa', async () => {
    const original = await submit().expect(201);
    const content = fixture({ version: 2 }); content.preguntas[0].opcionCorrectaId = 'b';
    const next = (await EvaluationModel().create(content))._id.toString();
    await submit({ ...body(), version: 2 }).expect(409);
    await submit(body(), next).expect(409);
    const corrected = await submit({ ...body(7), version: 2 }, next).expect(201); expect(corrected.body.aciertos).toBe(6);
    expect((await get(`intentos-evaluacion/${original.body.id}`).expect(200)).body).toEqual(original.body);
    expect((await get(`evaluaciones/${published}`).expect(200)).body.version).toBe(1);
    const hydrated = await EvaluationModel().findById(published).select('+preguntas.opcionCorrectaId'); hydrated!.preguntas[0].texto = 'Cambio silencioso';
    await expect(hydrated!.save()).rejects.toThrow('Documento histórico inmutable');
    await expect(EvaluationModel().updateOne({ _id: published }, { $set: { version: 99 } })).rejects.toThrow('Documento histórico inmutable');
    await expect(AttemptModel().updateOne({ _id: original.body.id }, { $set: { porcentaje: 100 } })).rejects.toThrow('Documento histórico inmutable');
  });
  it('historial privado, filtros, paginación y orden determinista', async () => {
    const emptyUser = new Types.ObjectId();
    await connection.db!.collection('usuarios').insertOne({ _id: emptyUser, nombre: 'Otro', correo: 'empty@example.test', rol: 'estudiante', verificadoEn: new Date() });
    const emptyAccess = app.get(AccessTokenService).sign(emptyUser.toString());
    expect((await get('intentos-evaluacion', emptyAccess).expect(200)).body.items).toEqual([]);
    const own = await submit().expect(201), foreign = await submit(body(), published, secondAccess).expect(201);
    await get(`intentos-evaluacion/${foreign.body.id}`).expect(404); await get(`intentos-evaluacion/${own.body.id}`, secondAccess).expect(404);
    await get(`intentos-evaluacion/${new Types.ObjectId()}`).expect(404);
    const result = await get('intentos-evaluacion').query({ evaluacionId: published, moduloId: moduleId.toString(), limite: 2, orden: 'porcentaje_desc' }).expect(200);
    expect(result.body.items).toHaveLength(2); expect(result.body.hayMas).toBe(true);
    expect(result.body.items[0].porcentaje).toBeGreaterThanOrEqual(result.body.items[1].porcentaje);
    expect(result.body.items.every((item: { evaluacionId: string }) => item.evaluacionId === published)).toBe(true);
    expect(result.text).not.toContain(foreign.body.id); expect(result.text).not.toMatch(/opcionCorrectaId|contraseñaHash|usuarioId/);
    const page2 = await get('intentos-evaluacion').query({ limite: 2, pagina: 2, orden: 'porcentaje_desc', evaluacionId: published }).expect(200);
    expect(page2.body.items.some((item: { id: string }) => result.body.items.some((before: { id: string }) => before.id === item.id))).toBe(false);
  });
  it('falla cerrado ante índices ausentes/incompatibles y no instala ninguno', async () => {
    const name = 'usuarioId_1_solicitudId_1'; await AttemptModel().collection.dropIndex(name); // Owned UUID only.
    try {
      await submit().expect(503);
      expect((await AttemptModel().collection.indexes()).some((i) => i.name === name)).toBe(false);
      await AttemptModel().collection.createIndex({ usuarioId: 1, solicitudId: 1 }, { name, unique: true, hidden: true });
      await submit().expect(503); await AttemptModel().collection.dropIndex(name);
      await AttemptModel().collection.createIndex({ usuarioId: 1, solicitudId: 1 }, { name }); await submit().expect(503);
    } finally { if ((await AttemptModel().collection.indexes()).some((i) => i.name === name)) await AttemptModel().collection.dropIndex(name); await AttemptModel().createIndexes(); }
    await submit().expect(201);
  });
  it('MongoDB fallido no registra ni expone errores internos', async () => {
    const input = body(), before = await rawAttempts().countDocuments();
    const spy = jest.spyOn(AttemptModel(), 'create').mockRejectedValueOnce(new Error('synthetic-private-db-failure'));
    try { const result = await submit(input).expect(503); expect(result.text + logs.join('\n')).not.toContain('synthetic-private-db-failure'); } finally { spy.mockRestore(); }
    expect(await rawAttempts().countDocuments()).toBe(before); await submit(input).expect(201);
    const read = jest.spyOn(EvaluationModel(), 'findOne').mockImplementationOnce(() => { throw new Error('synthetic-private-read'); });
    try { const result = await get(`evaluaciones/${published}`).expect(503); expect(result.text + logs.join('\n')).not.toContain('synthetic-private-read'); } finally { read.mockRestore(); }
  });
  it('contenido importado incoherente falla cerrado, sin exponer la clave', async () => {
    const created = await connection.db!.collection('evaluaciones').insertOne({ ...fixture(), preguntas: [{ id: 'q1', texto: 'Sintética', opciones: [{ id: 'a', texto: 'A' }], opcionCorrectaId: 'missing' }] });
    const result = await get(`evaluaciones/${created.insertedId}`).expect(503); expect(result.text).not.toContain('missing');
  });
  it('exige autenticación, verificación de correo y rol persistido', async () => {
    for (const path of [`evaluaciones/${published}`, 'intentos-evaluacion']) await request(app.getHttpServer()).get(`/api/v1/${path}`).expect(401);
    await request(app.getHttpServer()).post(`/api/v1/evaluaciones/${published}/intentos`).send(body()).expect(401);
    await get(`evaluaciones/${published}`, 'invalid-jwt').expect(401);
    for (const [rol, verificadoEn, status] of [['valor-no-aprobado', new Date(), 403], ['estudiante', null, 401]] as const) {
      const _id = new Types.ObjectId(); await connection.db!.collection('usuarios').insertOne({ _id, nombre: 'Sintético', correo: `${_id}@example.test`, rol, verificadoEn });
      await get(`evaluaciones/${published}`, app.get(AccessTokenService).sign(_id.toString())).expect(status);
    }
    expect(logs.join('\n')).not.toContain(access); expect(logs.join('\n')).not.toContain('synthetic-private-hash');
  });

  describe('Examen final con contratos externos simulados explícitamente', () => {
    async function scenario() {
      const cursoId = new Types.ObjectId();
      const eligibility: FinalExamEligibility = { cursoId: cursoId.toString(), modulosCompletados: Array.from({ length: 5 }, () => new Types.ObjectId().toString()), proyectoEntregado: true };
      eligibilityFixtures.set(cursoId.toString(), eligibility);
      const exam = await EvaluationModel().create(fixture({ cursoId, moduloId: null, tipo: 'examen_final' }));
      const id = exam._id.toString(), query = { cursoId: cursoId.toString() };
      return { id, cursoId, eligibility, query,
        get: (target = id, token = access) => get(`evaluaciones/${target}`, token).query(query),
        submit: (input = body(), target = id, token = access) => submit(input, target, token).query(query),
        list: () => get('evaluaciones').query({ ...query, tipo: 'examen_final' }),
        version: async (version: number, estado: 'publicado' | 'borrador' = 'publicado') => (await EvaluationModel().create(fixture({ cursoId, moduloId: null, tipo: 'examen_final', version, estado })))._id.toString(),
      };
    }
    it('entrega publicado elegible y listado por curso sin claves de corrección', async () => {
      const s = await scenario(), response = await s.get().expect(200);
      expect(response.body).toMatchObject({ tipo: 'examen_final', moduloId: null, cursoId: s.cursoId.toString() });
      expect(response.body.preguntas).toHaveLength(10); // No unverified mandatory academic size of 30.
      expect(response.text).not.toMatch(/opcionCorrectaId|contraseñaHash|synthetic-private/);
      expect(context.finalExamEligibility).toHaveBeenCalledWith({ usuarioId: user.toString(), evaluacionId: s.id, cursoId: s.cursoId.toString(), moduloId: null, version: 1 });
      expect((await s.list().expect(200)).body.items.map((e: { id: string }) => e.id)).toEqual([s.id]);
      await get('evaluaciones').query({ tipo: 'examen_final' }).expect(400);
      await get('evaluaciones').query({ ...s.query, tipo: 'examen_final', moduloId: moduleId.toString() }).expect(400);
    });
    it.each(['borrador', 'inexistente'] as const)('no entrega ni acepta examen %s', async (kind) => {
      const s = await scenario(), target = kind === 'borrador' ? await s.version(2, 'borrador') : new Types.ObjectId().toString();
      await s.get(target).expect(404); await s.submit(body(), target).expect(404);
    });
    it('exige autenticación y rol de estudiante también para finales', async () => {
      const s = await scenario();
      await request(app.getHttpServer()).get(`/api/v1/evaluaciones/${s.id}`).query(s.query).expect(401);
      await request(app.getHttpServer()).post(`/api/v1/evaluaciones/${s.id}/intentos`).query(s.query).send(body()).expect(401);
      const _id = new Types.ObjectId();
      await connection.db!.collection('usuarios').insertOne({ _id, nombre: 'Sintético', correo: 'final-role@example.test', rol: 'no-aprobado', verificadoEn: new Date() });
      await s.get(s.id, app.get(AccessTokenService).sign(_id.toString())).expect(403);
      await s.submit(body(), s.id, app.get(AccessTokenService).sign(_id.toString())).expect(403);
    });
    it.each(['módulos incompletos', 'proyecto ausente'] as const)('rechaza %s sin registrar ni revelar preguntas', async (kind) => {
      const s = await scenario();
      if (kind === 'módulos incompletos') s.eligibility.modulosCompletados = s.eligibility.modulosCompletados.slice(0, 4);
      else s.eligibility.proyectoEntregado = false;
      const denied = await s.get().expect(403); expect(denied.body.preguntas).toBeUndefined();
      await s.submit().expect(403); expect((await s.list().expect(200)).body.items).toEqual([]);
      expect(await rawAttempts().countDocuments({ cursoId: s.cursoId })).toBe(0);
    });
    it.each(['progreso', 'entregas'] as const)('falla cerrado cuando %s no está disponible', async (dependency) => {
      const s = await scenario();
      for (const action of [() => s.get(), () => s.submit(), () => s.list()]) {
        context.finalExamEligibility.mockRejectedValueOnce(new Error(`synthetic-private-${dependency}`));
        const response = await action().expect(503); expect(response.text + logs.join('\n')).not.toContain(`synthetic-private-${dependency}`);
      }
      expect(await rawAttempts().countDocuments({ cursoId: s.cursoId })).toBe(0);
    });
    it('no confía en elegibilidad enviada por cliente ni permite cambiar el curso', async () => {
      const s = await scenario();
      await get(`evaluaciones/${s.id}`).query({ cursoId: course.toString() }).expect(404);
      await submit(body(), s.id).query({ cursoId: course.toString() }).expect(404);
      for (const field of ['completado', 'proyectoEntregado', 'intentosRestantes', 'cursoId', 'usuarioId']) await s.submit({ ...body(), [field]: true }).expect(400);
      await s.get().query({ completado: true }).expect(400);
      s.eligibility.cursoId = course.toString(); await s.get().expect(403);
    });
    it('rechaza evidencia incoherente de módulos duplicados o ausente', async () => {
      const s = await scenario(); s.eligibility.modulosCompletados = Array(5).fill(moduleId.toString());
      await s.get().expect(503); await s.submit().expect(503);
      context.finalExamEligibility.mockResolvedValueOnce(undefined as never); await s.get().expect(503);
    });
    it('revalida módulos y entrega al enviar, aunque las preguntas ya se consultaron', async () => {
      const s = await scenario(); await s.get().expect(200);
      s.eligibility.proyectoEntregado = false; await s.submit().expect(403);
      s.eligibility.proyectoEntregado = true; s.eligibility.modulosCompletados = [];
      await s.submit().expect(403); expect(await rawAttempts().countDocuments({ cursoId: s.cursoId })).toBe(0);
    });
    it('califica primer, segundo y tercer intento, rechaza el cuarto y conserva historial', async () => {
      const s = await scenario(), results = app.get(AssessmentResultsPort);
      expect(await results.hasPassedFinalExam(user.toString(), s.cursoId.toString())).toBe(false);
      const inputs = [body(6), body(7), body(10)], responses = [];
      for (let i = 0; i < inputs.length; i++) {
        const response = await s.submit(inputs[i]).expect(201); responses.push(response.body);
        expect(response.body.id).toBe(finalAttemptId(user, s.cursoId, i + 1).toHexString());
      }
      expect(responses.map((r) => [r.porcentaje, r.aprobado])).toEqual([[60, false], [70, true], [100, true]]);
      await s.submit().expect(403); await s.get().expect(403);
      expect((await s.list().expect(200)).body.items).toEqual([]);
      const replayed = await s.submit(inputs[2]).expect(201); expect(replayed.body).toEqual(responses[2]);
      await s.submit({ ...inputs[2], respuestas: assessmentAnswers(6) }).expect(409);
      expect(await rawAttempts().countDocuments({ usuarioId: user, cursoId: s.cursoId })).toBe(3);
      const history = await get('intentos-evaluacion').query(s.query).expect(200);
      expect(history.body.items).toHaveLength(3); expect(history.body.items.every((r: { moduloId: unknown }) => r.moduloId === null)).toBe(true);
      expect(await results.hasPassedFinalExam(user.toString(), s.cursoId.toString())).toBe(true);
      expect(await results.hasPassedFinalExam(secondUser.toString(), s.cursoId.toString())).toBe(false);
      expect(history.text + logs.join('\n')).not.toContain('opcionCorrectaId');
    });
    it('el mismo solicitudId concurrente registra un único intento', async () => {
      const s = await scenario(), input = body();
      const responses = await Promise.all(Array.from({ length: 6 }, () => s.submit(input)));
      expect(responses.map((r) => r.status)).toEqual(Array(6).fill(201));
      expect(new Set(responses.map((r) => r.body.id)).size).toBe(1);
      expect(await rawAttempts().countDocuments({ usuarioId: user, cursoId: s.cursoId })).toBe(1);
      await s.submit({ ...input, respuestas: [...input.respuestas].reverse() }).expect(201);
    }, 20000);
    it('concurrencia con último cupo entre servicios independientes y versiones deja un único ganador', async () => {
      const s = await scenario(); await s.submit().expect(201); await s.submit().expect(201);
      const version2 = await s.version(2), other = new AssessmentsService(connection, EvaluationModel(), AttemptModel(), context);
      const responses = await Promise.all([
        s.submit(), s.submit(body()), s.submit({ ...body(), version: 2 }, version2),
        other.submit(user.toString(), s.id, body(), s.cursoId.toString()).then(() => ({ status: 201 }), (error: { getStatus(): number }) => ({ status: error.getStatus() })),
      ]);
      expect(responses.map((r) => r.status).sort()).toEqual([201, 403, 403, 403]);
      expect(await rawAttempts().countDocuments({ usuarioId: user, cursoId: s.cursoId, moduloId: null })).toBe(3);
    }, 20000);
    it('seis solicitudes diferentes desde cero nunca superan tres intentos', async () => {
      const s = await scenario(), responses = await Promise.all(Array.from({ length: 6 }, () => s.submit()));
      expect(responses.map((r) => r.status).sort()).toEqual([201, 201, 201, 403, 403, 403]);
      expect(await rawAttempts().countDocuments({ usuarioId: user, cursoId: s.cursoId })).toBe(3);
    }, 20000);
    it('una nueva versión no reinicia cuotas y conserva resultados de la anterior', async () => {
      const s = await scenario(), input = body(), first = await s.submit(input).expect(201), version2 = await s.version(2);
      await s.submit({ ...body(), version: 2 }, version2).expect(201);
      await s.submit(body(), version2).expect(409);
      await s.submit({ ...body(), version: 2 }, version2).expect(201);
      await s.submit().expect(403); await s.submit({ ...body(), version: 2 }, version2).expect(403);
      expect((await get(`intentos-evaluacion/${first.body.id}`).expect(200)).body).toEqual(first.body);
      await s.submit(input).expect(201);
    });
    it('incluye intentos históricos con ObjectId aleatorio, sin migrarlos ni sobrescribirlos', async () => {
      const s = await scenario();
      for (let i = 0; i < 2; i++) await AttemptModel().create({ usuarioId: user, evaluacionId: new Types.ObjectId(s.id), cursoId: s.cursoId, moduloId: null, version: 1, solicitudId: `legacy-${randomUUID()}`, respuestas: assessmentAnswers(6), aciertos: 6, total: 10, porcentaje: 60, aprobado: false, fecha: new Date() });
      const v2 = await s.version(2), response = await s.submit({ ...body(), version: 2 }, v2).expect(201);
      expect(response.body.id).toBe(finalAttemptId(user, s.cursoId, 3).toHexString());
      await s.submit().expect(403); expect(await rawAttempts().countDocuments({ usuarioId: user, cursoId: s.cursoId })).toBe(3);
    });
    it('mantiene cupos por estudiante/curso e historial privado', async () => {
      const a = await scenario(), b = await scenario();
      for (let i = 0; i < 3; i++) await a.submit().expect(201);
      const sameRequest = body(), own = await b.submit(sameRequest).expect(201), foreign = await a.submit(sameRequest, a.id, secondAccess).expect(201);
      await get(`intentos-evaluacion/${foreign.body.id}`).expect(404);
      await get(`intentos-evaluacion/${own.body.id}`, secondAccess).expect(404);
      expect((await get('intentos-evaluacion', secondAccess).query(a.query).expect(200)).body.items.map((r: { id: string }) => r.id)).toEqual([foreign.body.id]);
    });
    it.each(['incomplete', 'duplicate', 'question', 'option'] as const)('respuestas %s no consumen cupo', async (kind) => {
      const s = await scenario(), input = body();
      if (kind === 'incomplete') input.respuestas.pop();
      if (kind === 'duplicate') input.respuestas[1] = input.respuestas[0];
      if (kind === 'question') input.respuestas[0].preguntaId = 'unknown';
      if (kind === 'option') input.respuestas[0].opcionId = 'unknown';
      await s.submit(input).expect(400); expect(await rawAttempts().countDocuments({ cursoId: s.cursoId })).toBe(0);
      await s.submit().expect(201);
    });
    it('fallos de MongoDB no consumen cupo, no exponen detalles y permiten reintentar', async () => {
      const s = await scenario(), input = body(), spy = jest.spyOn(AttemptModel(), 'create').mockRejectedValueOnce(new Error('synthetic-private-final-mongo'));
      try { const response = await s.submit(input).expect(503); expect(response.text + logs.join('\n')).not.toContain('synthetic-private-final-mongo'); } finally { spy.mockRestore(); }
      expect(await rawAttempts().countDocuments({ cursoId: s.cursoId })).toBe(0); await s.submit(input).expect(201);
      const count = jest.spyOn(AttemptModel(), 'countDocuments').mockImplementationOnce(() => { throw new Error('synthetic-private-count'); });
      try { const response = await s.get().expect(503); expect(response.text + logs.join('\n')).not.toContain('synthetic-private-count'); } finally { count.mockRestore(); }
    });
    it('colisión del identificador con documento ajeno falla cerrado sin modificarlo', async () => {
      const s = await scenario(), _id = finalAttemptId(user, s.cursoId, 1);
      await AttemptModel().create({ _id, usuarioId: secondUser, evaluacionId: new Types.ObjectId(published), cursoId: course, moduloId: moduleId, version: 1, solicitudId: randomUUID(), respuestas: assessmentAnswers(), aciertos: 7, total: 10, porcentaje: 70, aprobado: true, fecha: new Date() });
      const before = await rawAttempts().findOne({ _id }); await s.submit().expect(503);
      expect(await rawAttempts().findOne({ _id })).toEqual(before);
      expect(await rawAttempts().countDocuments({ usuarioId: user, cursoId: s.cursoId })).toBe(0);
    });
    it('cuestionarios siguen ilimitados aunque se agoten los finales', async () => {
      const s = await scenario(); for (let i = 0; i < 3; i++) await s.submit().expect(201);
      await s.submit().expect(403);
      for (let i = 0; i < 4; i++) await submit().expect(201);
      expect((await get(`evaluaciones/${published}`).expect(200)).body.tipo).toBe('cuestionario');
    });
  });
});
