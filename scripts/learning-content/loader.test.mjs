// Pruebas del cargador de contenido. Ejecutar con: node --test scripts/learning-content/loader.test.mjs
// Usan una base en memoria: no necesitan MongoDB ni dependencias instaladas.
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { loadContent, validateContent, buildPlan } from './content.mjs';
import { syncContent, syncContentAtomic, countContent, assertSafeTarget, assertSafeDatabase } from './sync.mjs';
import { createMemoryDb } from './memory-db.mjs';
import { explainError } from './errors.mjs';

const dir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'docs', 'contenido', 'json');
const hasContent = existsSync(path.join(dir, 'curso.json'));
const opts = { skip: hasContent ? false : 'No hay contenido en docs/contenido/json' };

async function fresh() {
  const content = await loadContent(dir, { includePending: true });
  return structuredClone(content);
}

test('el contenido real es válido', opts, async () => {
  const content = await fresh();
  assert.deepEqual(validateContent(content, { includePending: true }), []);
});

test('la carga crea todo y una segunda carga no cambia nada (idempotente)', opts, async () => {
  const content = await fresh();
  const plan = buildPlan(content, { includePending: true });
  const db = createMemoryDb();
  const first = await syncContent(db, plan);
  assert.deepEqual(await countContent(db), { cursos: 1, modulos: 5, lecciones: 50, flashcards: 50, evaluaciones: 6, simuladores: 5 });
  assert.equal(first.lecciones.creados, 50);
  const writesAfterFirst = db.writes;
  const second = await syncContent(db, plan);
  for (const s of Object.values(second)) assert.deepEqual([s.creados, s.actualizados], [0, 0]);
  assert.equal(db.writes, writesAfterFirst, 'la segunda carga no debe escribir');
  assert.deepEqual(await countContent(db), { cursos: 1, modulos: 5, lecciones: 50, flashcards: 50, evaluaciones: 6, simuladores: 5 });
});

test('resuelve las referencias y no guarda moduloOrden', opts, async () => {
  const content = await fresh();
  const db = createMemoryDb();
  await syncContent(db, buildPlan(content, { includePending: true }));
  const cursoId = db.dump('cursos')[0]._id.toHexString();
  const modulos = db.dump('modulos');
  assert.ok(modulos.every((m) => m.cursoId.toHexString() === cursoId));
  const ids = new Set(modulos.map((m) => m._id.toHexString()));
  for (const name of ['lecciones', 'flashcards', 'simuladores']) {
    for (const d of db.dump(name)) {
      assert.ok(ids.has(d.moduloId.toHexString()), `${name}: moduloId inválido`);
      assert.equal('moduloOrden' in d, false);
    }
  }
  const examen = db.dump('evaluaciones').filter((e) => e.tipo === 'examen_final');
  assert.equal(examen.length, 1);
  assert.equal(examen[0].moduloId, null);
  assert.equal(examen[0].preguntas.length, 30);
  assert.equal(db.dump('evaluaciones').filter((e) => e.tipo === 'cuestionario').every((e) => e.preguntas.length === 10), true);
});

test('un cambio en una lección actualiza solo ese documento', opts, async () => {
  const content = await fresh();
  const db = createMemoryDb();
  await syncContent(db, buildPlan(content, { includePending: true }));
  content.lecciones[3].lecciones[4].titulo = 'Título corregido';
  const stats = await syncContent(db, buildPlan(content, { includePending: true }));
  assert.equal(stats.lecciones.actualizados, 1);
  assert.equal(stats.lecciones.sinCambios, 49);
  assert.equal(db.dump('lecciones').length, 50);
});

test('la validación detecta contenido inválido', opts, async () => {
  const base = await fresh();
  const casos = {
    'dos opciones correctas': (c) => { c.evaluaciones[0].preguntas[0].opciones[0].correcta = true; },
    'bloque con campo extra': (c) => { c.lecciones[1].lecciones[0].secciones[0].icono = 'x'; },
    'tipo de bloque desconocido': (c) => { c.lecciones[1].lecciones[0].secciones[0].tipo = 'imagen'; },
    'más de 20 secciones': (c) => { const s = c.lecciones[1].lecciones[0].secciones; while (s.length < 21) s.push({ tipo: 'parrafo', texto: 'x' }); },
    'caracter de control': (c) => { c.lecciones[2].lecciones[0].titulo = 'Hola\u0001'; },
    'Markdown': (c) => { c.lecciones[2].lecciones[0].secciones[0] = { tipo: 'parrafo', texto: 'esto es **negrita**' }; },
    'texto interno': (c) => { c.lecciones[2].lecciones[0].secciones[0] = { tipo: 'parrafo', texto: 'revisar ⚠️' }; },
    'estado inválido': (c) => { c.curso.estado = 'publicada'; },
    'modo inválido': (c) => { c.simuladores[0].modo = 'automatico'; },
    'cuestionario con 9 preguntas': (c) => { c.evaluaciones[0].preguntas.pop(); },
    'examen con 29 preguntas': (c) => { c.examen.preguntas.pop(); },
    'examen repite cuestionarios': (c) => { for (let i = 0; i < 6; i++) c.examen.preguntas[i].enunciado = c.evaluaciones[0].preguntas[i].enunciado; },
    'lección 10 sin cuestionario': (c) => { c.lecciones[1].lecciones[9].secciones = c.lecciones[1].lecciones[9].secciones.filter((b) => b.tipo !== 'recurso'); },
    'formato de proyecto no permitido': (c) => { c.curso.proyectoFinal.formatosPermitidos.push('ZIP'); },
  };
  for (const [nombre, mutar] of Object.entries(casos)) {
    const c = structuredClone(base);
    mutar(c);
    assert.notDeepEqual(validateContent(c, { includePending: true }), [], `debería rechazar: ${nombre}`);
  }
});

test('solo se permite una base de pruebas local', () => {
  assert.doesNotThrow(() => assertSafeTarget('mongodb://127.0.0.1:27018/?replicaSet=lethics-rs', 'lethics_content_test_abc123'));
  assert.throws(() => assertSafeTarget('mongodb://127.0.0.1:27018', 'lethics'), /no es válida/);
  assert.throws(() => assertSafeTarget('mongodb://127.0.0.1:27018', 'lethics_content_test_ABC'), /no es válida/);
  assert.throws(() => assertSafeTarget('mongodb://db.example.com:27017', 'lethics_content_test_abc'), /local/);
  assert.throws(() => assertSafeTarget('mongodb+srv://cluster.example.com', 'lethics_content_test_abc'), /mongodb:\/\//);
  assert.throws(() => assertSafeTarget(undefined, 'lethics_content_test_abc'), /LETHICS_CONTENT_LOAD_URI/);
});

test('solo se admite el puerto 27018 (el 27017 es de otro proyecto)', () => {
  assert.throws(() => assertSafeTarget('mongodb://127.0.0.1:27017', 'lethics_content_test_abc'), /27018/);
  assert.throws(() => assertSafeTarget('mongodb://127.0.0.1', 'lethics_content_test_abc'), /27018/);
  assert.throws(() => assertSafeTarget('mongodb://usuario:clave@localhost:27017/?authSource=admin', 'lethics_content_test_abc'), /27018/);
  assert.doesNotThrow(() => assertSafeTarget('mongodb://usuario:clave@localhost:27018/?authSource=admin&directConnection=true', 'lethics_content_test_abc'));
});

test('se niega a escribir en una base con colecciones ajenas al contenido', async () => {
  const db = createMemoryDb();
  await assertSafeDatabase(db); // vacía: permitida
  await db.collection('lecciones').insertOne({ x: 1 });
  await assertSafeDatabase(db); // solo colecciones de contenido: permitida
  await db.collection('usuarios').insertOne({ x: 1 });
  await assert.rejects(() => assertSafeDatabase(db), /usuarios/);
});

test('la carga usa un bulkWrite por colección y la repetida no escribe', opts, async () => {
  const content = await fresh();
  const plan = buildPlan(content, { includePending: true });
  const db = createMemoryDb();
  await syncContent(db, plan);
  assert.equal(db.bulkCalls, 6, 'un bulkWrite por colección');
  assert.equal(db.writes, 1 + 5 + 50 + 50 + 6 + 5);
  await syncContent(db, plan);
  assert.equal(db.bulkCalls, 6, 'la segunda carga no debe llamar a bulkWrite');
});

test('elimina los campos sobrantes de un documento existente', opts, async () => {
  const content = await fresh();
  const plan = buildPlan(content, { includePending: true });
  const db = createMemoryDb();
  await syncContent(db, plan);
  const leccion = db.dump('lecciones')[0];
  await db.collection('lecciones').updateOne({ _id: leccion._id }, { $set: { campoViejo: 'sobra' } });
  assert.equal('campoViejo' in db.dump('lecciones')[0], true);
  const stats = await syncContent(db, plan);
  assert.equal(stats.lecciones.actualizados, 1);
  assert.equal(stats.lecciones.sinCambios, 49);
  assert.equal('campoViejo' in db.dump('lecciones')[0], false);
});

test('se detiene sin escribir si la base tiene claves duplicadas', opts, async () => {
  const content = await fresh();
  const plan = buildPlan(content, { includePending: true });
  const db = createMemoryDb();
  await syncContent(db, plan);
  const copia = { ...db.dump('lecciones')[0] };
  delete copia._id;
  await db.collection('lecciones').insertOne(copia);
  const writes = db.writes;
  await assert.rejects(() => syncContent(db, plan), /Hay 2 documentos/);
  assert.equal(db.writes, writes, 'no debe escribir nada');
});

test('el plan con una clave repetida se rechaza antes de escribir esa colección', opts, async () => {
  const content = await fresh();
  const plan = buildPlan(content, { includePending: true });
  plan.simuladores.push({ ...plan.simuladores[0] });
  await assert.rejects(() => syncContent(createMemoryDb(), plan), /repite la clave natural/);
});

test('la versión atómica usa una sesión y la cierra', opts, async () => {
  const content = await fresh();
  const plan = buildPlan(content, { includePending: true });
  const db = createMemoryDb();
  const eventos = [];
  const client = {
    startSession: () => ({
      withTransaction: async (fn, options) => { eventos.push(['transaccion', options.writeConcern.w]); await fn(); },
      endSession: async () => { eventos.push(['cerrada']); },
    }),
  };
  const stats = await syncContentAtomic(client, db, plan, { ensureIndexes: true });
  assert.equal(stats.lecciones.creados, 50);
  assert.deepEqual(eventos, [['transaccion', 'majority'], ['cerrada']]);
  await assert.rejects(() => syncContentAtomic({ startSession: () => ({ withTransaction: async () => { throw new Error('falla'); }, endSession: async () => { eventos.push(['cerrada']); } }) }, db, plan), /falla/);
  assert.equal(eventos.filter(([e]) => e === 'cerrada').length, 2, 'la sesión se cierra aunque falle');
});

test('los errores del driver se explican en español y no revelan el URI', () => {
  assert.match(explainError({ name: 'MongooseServerSelectionError', message: 'x' }), /No se pudo conectar/);
  assert.match(explainError({ name: 'MongoServerError', code: 18, message: 'Authentication failed.' }), /autenticación/);
  assert.match(explainError({ name: 'MongoServerError', code: 11000, keyPattern: { moduloId: 1, orden: 1 }, message: 'E11000' }), /Clave duplicada.*moduloId/);
  assert.match(explainError({ name: 'MongoBulkWriteError', writeErrors: [{ code: 11000 }], message: 'E11000' }), /Clave duplicada/);
  assert.match(explainError({ name: 'MongoServerError', code: 20, message: 'Transaction numbers are only allowed on a replica set member or mongos' }), /replica set/);
  const texto = explainError(new Error('fallo con mongodb://usuario:secreta@127.0.0.1:27018/x'));
  assert.doesNotMatch(texto, /secreta|usuario/);
});
