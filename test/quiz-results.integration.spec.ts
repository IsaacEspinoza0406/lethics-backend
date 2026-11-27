import { Global, INestApplication, Module, ServiceUnavailableException } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { getConnectionToken } from '@nestjs/mongoose';
import { Test } from '@nestjs/testing';
import mongoose, { Connection, Types } from 'mongoose';
import { randomBytes } from 'node:crypto';
import { AssessmentResultsPort } from '../src/modules/assessments/application/assessment-context';
import { AssessmentsService } from '../src/modules/assessments/application/assessments.service';
import { AssessmentsModule } from '../src/modules/assessments/assessments.module';
import { Attempt, Evaluation } from '../src/modules/assessments/domain/assessment';
import { optionalMongoTestScope } from './integration-isolation';
import { QuizResultRecord, quizResultFixture } from './quiz-results-fixtures';

const scope = optionalMongoTestScope(process.env.LETHICS_IDENTITY_TEST_URI, 'ops');
(scope ? describe : describe.skip)('Resultados de cuestionarios: puerto Nest y MongoDB UUID propio', () => {
  let connection: Connection, app: INestApplication, results: AssessmentResultsPort;
  const user = new Types.ObjectId(), secondUser = new Types.ObjectId(), course = new Types.ObjectId(), moduleId = new Types.ObjectId();
  @Global()
  @Module({ providers: [{ provide: getConnectionToken(), useFactory: () => connection }], exports: [getConnectionToken()] })
  class TemporaryConnectionModule {}
  const raw = () => connection.db!.collection('intentos_evaluacion');
  const evaluations = () => connection.model<Evaluation>('Evaluacion');
  const attempts = () => connection.model<Attempt>('IntentoEvaluacion');
  const fixture = (correct = 7, overrides: Partial<Attempt> = {}) => quizResultFixture(correct, { usuarioId: user, cursoId: course, moduloId: moduleId, ...overrides });
  const read = (student = user, courseId = course) => results.quizResults(student.toHexString(), courseId.toHexString());
  async function store(record: QuizResultRecord, malformed = false) {
    const { evaluacion, ...attempt } = record;
    await evaluations().create(evaluacion);
    if (malformed) await raw().insertOne(attempt); // Only this execution's owned UUID database.
    else await attempts().create(attempt);
  }
  beforeAll(async () => {
    const temporary = await scope!.open(); connection = mongoose.createConnection().setClient(temporary.client);
    for (const name of ['evaluaciones', 'intentos_evaluacion']) await temporary.db.createCollection(name);
    const settings = { NODE_ENV: 'test', AUTH_HTTP_ENABLED: false, JWT_ACCESS_SECRET_BASE64: randomBytes(32).toString('base64'), JWT_ACCESS_ISSUER: 'quiz-results-test', JWT_ACCESS_AUDIENCE: 'quiz-results-test', JWT_ACCESS_TTL_SECONDS: 900,
      VERIFICATION_CODE_HMAC_KEY_BASE64: randomBytes(32).toString('base64'), RATE_LIMIT_HMAC_KEY_BASE64: randomBytes(32).toString('base64'), VERIFICATION_ACCOUNT_FAILURES_PER_HOUR: 20, VERIFICATION_ACCOUNT_EMISSIONS_PER_HOUR: 5 };
    const module = await Test.createTestingModule({ imports: [TemporaryConnectionModule,
      ConfigModule.forRoot({ isGlobal: true, ignoreEnvFile: true, load: [() => settings] }), AssessmentsModule] }).compile();
    app = module.createNestApplication({ logger: false }); await app.init();
    results = app.get(AssessmentResultsPort);
  }, 20000);
  beforeEach(async () => {
    // Raw cleanup bypasses append-only application middleware, exclusively inside the owned test DB.
    await raw().deleteMany({}); await connection.db!.collection('evaluaciones').deleteMany({});
  });
  afterAll(async () => {
    try { if (app) await app.close(); } finally { try { await scope?.close(); } finally { if (connection) await connection.close(); } }
  });
  it('resuelve el proveedor exportado y devuelve [] sin intentos', async () => {
    expect(results).toBe(app.get(AssessmentsService)); await expect(read()).resolves.toEqual([]);
  });
  it.each([6, 7])('incluye un intento completo con %s aciertos', async correct => {
    await store(fixture(correct)); await expect(read()).resolves.toEqual([{ moduloId: moduleId.toHexString(), aprobado: correct >= 7 }]);
  });
  it('varios reprobados producen un solo módulo reprobado', async () => {
    await store(fixture(4)); await store(fixture(6));
    await expect(read()).resolves.toEqual([{ moduloId: moduleId.toHexString(), aprobado: false }]);
  });
  it('reprobado seguido de aprobado y otro reprobado conserva la aprobación', async () => {
    for (const correct of [6, 7, 2]) await store(fixture(correct));
    await expect(read()).resolves.toEqual([{ moduloId: moduleId.toHexString(), aprobado: true }]);
  });
  it('agrupa versiones de evaluaciones distintas y preserva el histórico', async () => {
    await store(fixture(7)); await store(fixture(4, { version: 2 }));
    const before = await raw().find({}).sort({ _id: 1 }).toArray();
    await expect(read()).resolves.toEqual([{ moduloId: moduleId.toHexString(), aprobado: true }]);
    expect(await raw().find({}).sort({ _id: 1 }).toArray()).toEqual(before);
    expect(await evaluations().countDocuments({})).toBe(2);
  });
  it('excluye el examen final y mantiene hasPassedFinalExam', async () => {
    await store(fixture(6)); await store(fixture(7, { moduloId: null }));
    await expect(read()).resolves.toEqual([{ moduloId: moduleId.toHexString(), aprobado: false }]);
    await expect(results.hasPassedFinalExam(user.toString(), course.toString())).resolves.toBe(true);
    await expect(results.hasPassedFinalExam(secondUser.toString(), course.toString())).resolves.toBe(false);
  });
  it('mantiene resultados independientes por estudiante', async () => {
    await store(fixture(6)); await store(fixture(10, { usuarioId: secondUser }));
    await expect(read()).resolves.toEqual([{ moduloId: moduleId.toHexString(), aprobado: false }]);
    await expect(read(secondUser)).resolves.toEqual([{ moduloId: moduleId.toHexString(), aprobado: true }]);
  });
  it('mantiene resultados independientes por curso', async () => {
    const secondCourse = new Types.ObjectId(), secondModule = new Types.ObjectId();
    await store(fixture(6)); await store(fixture(10, { cursoId: secondCourse, moduloId: secondModule }));
    await expect(read()).resolves.toEqual([{ moduloId: moduleId.toHexString(), aprobado: false }]);
    await expect(read(user, secondCourse)).resolves.toEqual([{ moduloId: secondModule.toHexString(), aprobado: true }]);
  });
  it.each(['incomplete', 'duplicate', 'option', 'grade', 'version', 'module', 'course'] as const)('excluye documentos históricos inválidos: %s', async kind => {
    const record = fixture(10);
    if (kind === 'incomplete') record.respuestas.pop();
    if (kind === 'duplicate') record.respuestas[1] = record.respuestas[0];
    if (kind === 'option') record.respuestas[0].opcionId = 'unknown';
    if (kind === 'grade') record.respuestas[0].opcionId = 'b';
    if (kind === 'version') record.version++;
    if (kind === 'module') record.moduloId = new Types.ObjectId();
    if (kind === 'course') record.cursoId = new Types.ObjectId();
    await store(record, true); await expect(read()).resolves.toEqual([]);
    expect(await raw().countDocuments({})).toBe(1); // Query never repairs or deletes history.
  });
  it('excluye intentos huérfanos sin evaluación histórica', async () => {
    const { evaluacion, ...attempt } = fixture(10); void evaluacion;
    await raw().insertOne(attempt); await expect(read()).resolves.toEqual([]);
  });
  it('excluye un intento con módulo pero que referencia un examen final', async () => {
    const record = fixture(10, { moduloId: null }); record.moduloId = moduleId;
    await store(record, true); await expect(read()).resolves.toEqual([]);
  });
  it('no expone respuestas ni campos adicionales', async () => {
    await store(fixture()); const response = await read();
    expect(Object.keys(response[0]).sort()).toEqual(['aprobado', 'moduloId']);
    expect(JSON.stringify(response)).not.toMatch(/preguntas|respuestas|opcionCorrectaId|solicitudId|usuarioId|porcentaje/);
  });
  it('fallo de consulta MongoDB es 503, nunca []', async () => {
    const spy = jest.spyOn(attempts(), 'aggregate').mockImplementationOnce(() => { throw new Error('synthetic-private-mongo'); });
    try { await expect(read()).rejects.toBeInstanceOf(ServiceUnavailableException); } finally { spy.mockRestore(); }
    await expect(read()).resolves.toEqual([]);
  });
  it('colección ausente no se confunde con ausencia de intentos', async () => {
    await connection.db!.collection('evaluaciones').drop();
    try { await expect(read()).rejects.toBeInstanceOf(ServiceUnavailableException); }
    finally { await connection.db!.createCollection('evaluaciones'); }
  });
});
