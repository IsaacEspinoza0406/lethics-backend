// Pruebas de integración del cargador contra un MongoDB real (replica set local en el puerto 27018).
// Se omiten si no existe LETHICS_CONTENT_LOAD_URI. Cada prueba crea su propia base temporal con nombre
// aleatorio "lethics_content_test_it_<hex>", comprueba que no existía y borra únicamente esa base al terminar.
//
//   $env:LETHICS_CONTENT_LOAD_URI = "<URI de tu MongoDB local>"
//   node --test scripts/learning-content/loader.integration.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { loadContent, buildPlan } from './content.mjs';
import { syncContent, syncContentAtomic, countContent, assertSafeTarget, assertSafeDatabase, TEST_DB_PATTERN } from './sync.mjs';
import { explainError } from './errors.mjs';

const uri = process.env.LETHICS_CONTENT_LOAD_URI;
const dir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'docs', 'contenido', 'json');
const skip = !uri
  ? 'Define LETHICS_CONTENT_LOAD_URI para ejecutar las pruebas contra MongoDB'
  : !existsSync(path.join(dir, 'curso.json')) ? 'No hay contenido en docs/contenido/json' : false;

const ESPERADO = { cursos: 1, modulos: 5, lecciones: 50, flashcards: 50, evaluaciones: 6, simuladores: 5 };

async function freshPlan() {
  return buildPlan(structuredClone(await loadContent(dir, { includePending: true })), { includePending: true });
}

/** Crea una base temporal propia, ejecuta la prueba y borra solo esa base. */
async function withDb(fn) {
  const dbName = `lethics_content_test_it_${randomUUID().replaceAll('-', '')}`;
  assertSafeTarget(uri, dbName);
  const { default: mongoose } = await import('mongoose');
  const conn = await mongoose.createConnection(uri, { dbName, serverSelectionTimeoutMS: 5000 }).asPromise();
  const ownedDb = conn.db, ownedClient = conn.getClient();
  let owns = false;
  try {
    const { databases } = await conn.getClient().db().admin().listDatabases();
    assert.equal(databases.some((d) => d.name === dbName), false, 'La base de prueba ya existía');
    owns = true;
    await fn(conn);
  } finally {
    try {
      if (owns) {
        assert.ok(TEST_DB_PATTERN.test(dbName) && conn.name === dbName && conn.db === ownedDb && conn.getClient() === ownedClient, 'Se rechazó limpieza de una conexión/base no propietaria');
        await ownedDb.dropDatabase();
        const { databases } = await ownedClient.db('admin').admin().listDatabases();
        assert.equal(databases.some((d) => d.name === dbName), false, 'La base temporal no se limpió');
      }
    } finally { await conn.close(); }
  }
}

test('carga real: crea todo, la repetida no cambia nada y los tipos son los del modelo', { skip }, async () => {
  const plan = await freshPlan();
  await withDb(async (conn) => {
    const client = conn.getClient();
    const first = await syncContentAtomic(client, conn.db, plan, { ensureIndexes: true });
    assert.deepEqual(await countContent(conn.db), ESPERADO);
    assert.equal(first.lecciones.creados, 50);
    const second = await syncContentAtomic(client, conn.db, plan, { ensureIndexes: true });
    for (const [nombre, s] of Object.entries(second)) assert.deepEqual([nombre, s.creados, s.actualizados], [nombre, 0, 0]);
    assert.deepEqual(await countContent(conn.db), ESPERADO);

    const n = (coll, filter) => conn.db.collection(coll).countDocuments(filter);
    assert.equal(await n('modulos', { orden: { $type: 'int' }, cursoId: { $type: 'objectId' } }), 5);
    assert.equal(await n('lecciones', { orden: { $type: 'int' }, version: { $type: 'int' }, moduloId: { $type: 'objectId' } }), 50);
    assert.equal(await n('flashcards', { orden: { $type: 'int' }, moduloId: { $type: 'objectId' } }), 50);
    assert.equal(await n('simuladores', { version: { $type: 'int' }, moduloId: { $type: 'objectId' } }), 5);
    assert.equal(await n('evaluaciones', { version: { $type: 'int' }, minimoAprobatorio: { $type: 'int' }, cursoId: { $type: 'objectId' } }), 6);
    assert.equal(await n('evaluaciones', { tipo: 'examen_final', moduloId: null }), 1);
    assert.equal(await n('evaluaciones', { tipo: 'cuestionario', moduloId: { $type: 'objectId' } }), 5);
    for (const c of ['cursos', 'modulos', 'lecciones', 'flashcards', 'evaluaciones', 'simuladores']) assert.equal(await n(c, { moduloOrden: { $exists: true } }), 0, `${c} guardó moduloOrden`);

    // Las referencias apuntan a documentos reales (comprueba que bulkWrite devolvió los _id correctos).
    const cursoId = (await conn.db.collection('cursos').findOne({}))._id;
    const modIds = (await conn.db.collection('modulos').find({}).toArray()).map((m) => m._id);
    assert.equal(await n('modulos', { cursoId }), 5);
    assert.equal(await n('lecciones', { moduloId: { $in: modIds } }), 50);
    assert.equal(await n('flashcards', { moduloId: { $in: modIds } }), 50);
    assert.equal(await n('simuladores', { moduloId: { $in: modIds } }), 5);
    assert.equal(await n('evaluaciones', { cursoId }), 6);

    await assertSafeDatabase(conn.db);
  });
});

test('los documentos cargados satisfacen el esquema real de A1/A2 sin publicar borradores', { skip }, async () => {
  const { createRequire } = await import('node:module');
  const require = createRequire(import.meta.url);
  const { EvaluationSchema } = require('../../dist/modules/assessments/infrastructure/assessment.schemas.js');
  await withDb(async (conn) => {
    await syncContentAtomic(conn.getClient(), conn.db, await freshPlan());
    const Model = conn.model('ContentEvaluationCompatibility', EvaluationSchema);
    for (const doc of await conn.db.collection('evaluaciones').find({}).toArray()) {
      // Do not print Mongoose validation errors: they can contain private question values.
      const valid = await new Model(doc).validate().then(() => true, () => false);
      assert.equal(valid, true, 'Evaluación cargada incompatible con el esquema');
      assert.equal(doc.estado, 'borrador');
      assert.equal(doc.preguntas.every((q) => typeof q.opcionCorrectaId === 'string' && !('enunciado' in q) && q.opciones.every((o) => !('correcta' in o))), true);
    }
  });
});

test('rechaza cambios en una versión, revierte la carga completa y permite una versión nueva', { skip }, async () => {
  await withDb(async (conn) => {
    const plan = await freshPlan(), db = conn.db, client = conn.getClient();
    await syncContentAtomic(client, db, plan);
    const before = await db.collection('evaluaciones').findOne({ tipo: 'cuestionario' });
    plan.lecciones[0].doc.titulo = 'Cambio sintético que debe revertirse';
    plan.evaluaciones[0].doc.preguntas[0].texto = 'Cambio sintético de pregunta';
    await assert.rejects(() => syncContentAtomic(client, db, plan), /inmutable/);
    assert.equal(await db.collection('lecciones').countDocuments({ titulo: plan.lecciones[0].doc.titulo }), 0);
    assert.equal((await db.collection('evaluaciones').findOne({ _id: before._id })).preguntas[0].texto === before.preguntas[0].texto, true);
    plan.evaluaciones[0].doc.version++;
    await syncContentAtomic(client, db, plan);
    assert.equal(await db.collection('evaluaciones').countDocuments({}), 7);
    assert.ok(await db.collection('evaluaciones').findOne({ _id: before._id, version: before.version }));
  });
});

test('CLI existente aplica dos veces solo en la base UUID propia, sin cambios en la repetición', { skip }, async () => {
  await withDb(async (conn) => {
    const args = ['scripts/load-learning-content.mjs', '--include-pending', '--apply', '--db', conn.name];
    const run = () => promisify(execFile)(process.execPath, args, { env: { ...process.env, LETHICS_CONTENT_LOAD_URI: uri }, timeout: 30000 });
    for (let i = 0; i < 2; i++) {
      // Suppress child errors (which contain environment/driver details); assert only the outcome.
      const result = await run().then((value) => ({ ok: true, ...value }), () => ({ ok: false }));
      assert.equal(result.ok, true, 'Falló la carga CLI aislada');
      if (i === 1) {
        assert.equal((result.stdout.match(/creados\s+0 · actualizados\s+0/g) ?? []).length, 6);
      }
    }
    assert.deepEqual(await countContent(conn.db), ESPERADO);
  });
});

test('los índices únicos existen y rechazan duplicados con un mensaje claro', { skip }, async () => {
  const plan = await freshPlan();
  await withDb(async (conn) => {
    await syncContentAtomic(conn.getClient(), conn.db, plan, { ensureIndexes: true });
    const unicos = async (c) => (await conn.db.collection(c).indexes()).filter((i) => i.unique).map((i) => JSON.stringify(i.key));
    assert.deepEqual(await unicos('modulos'), ['{"cursoId":1,"orden":1}']);
    assert.deepEqual(await unicos('lecciones'), ['{"moduloId":1,"orden":1}']);
    const copia = { ...(await conn.db.collection('lecciones').findOne({})) };
    delete copia._id;
    await assert.rejects(() => conn.db.collection('lecciones').insertOne(copia), (err) => {
      assert.equal(err.code, 11000);
      assert.match(explainError(err), /Clave duplicada.*moduloId/);
      return true;
    });
    assert.equal(await conn.db.collection('lecciones').countDocuments({}), 50);
  });
});

test('actualiza lo que cambió y elimina los campos sobrantes en MongoDB real', { skip }, async () => {
  const content = structuredClone(await loadContent(dir, { includePending: true }));
  await withDb(async (conn) => {
    const client = conn.getClient();
    await syncContentAtomic(client, conn.db, buildPlan(content, { includePending: true }), { ensureIndexes: true });
    await conn.db.collection('flashcards').updateOne({}, { $set: { campoViejo: 'sobra' } });
    content.lecciones[3].lecciones[4].titulo = 'Título corregido';
    const stats = await syncContentAtomic(client, conn.db, buildPlan(content, { includePending: true }));
    assert.equal(stats.lecciones.actualizados, 1);
    assert.equal(stats.lecciones.sinCambios, 49);
    assert.equal(stats.flashcards.actualizados, 1);
    assert.equal(stats.flashcards.sinCambios, 49);
    assert.equal(await conn.db.collection('flashcards').countDocuments({ campoViejo: { $exists: true } }), 0);
    assert.equal(await conn.db.collection('lecciones').countDocuments({ titulo: 'Título corregido' }), 1);
    assert.deepEqual(await countContent(conn.db), ESPERADO);
  });
});

test('si la carga falla a medias, la transacción deja la base vacía', { skip }, async () => {
  const plan = await freshPlan();
  plan.simuladores.push({ ...plan.simuladores[0] }); // falla en la última colección, ya escritas las anteriores
  await withDb(async (conn) => {
    await assert.rejects(() => syncContentAtomic(conn.getClient(), conn.db, plan), /repite la clave natural/);
    assert.deepEqual(await countContent(conn.db), { cursos: 0, modulos: 0, lecciones: 0, flashcards: 0, evaluaciones: 0, simuladores: 0 });
  });
});

test('sin transacción, la misma falla sí deja datos parciales (por eso la transacción es la opción por defecto)', { skip }, async () => {
  const plan = await freshPlan();
  plan.simuladores.push({ ...plan.simuladores[0] });
  await withDb(async (conn) => {
    await assert.rejects(() => syncContent(conn.db, plan), /repite la clave natural/);
    const total = await countContent(conn.db);
    assert.equal(total.cursos, 1);
    assert.equal(total.lecciones, 50);
    assert.equal(total.simuladores, 0);
  });
});
