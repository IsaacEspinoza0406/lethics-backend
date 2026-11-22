// Synthetic fixtures only: no academic questions or answers are versioned here.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { assessmentDocument, buildPlan } from './content.mjs';
import { syncContent, assertSafeTarget } from './sync.mjs';
import { createMemoryDb } from './memory-db.mjs';
import { explainError } from './errors.mjs';

export function syntheticAssessment(tipo = 'cuestionario', version = 1) {
  return {
    ...(tipo === 'cuestionario' ? { moduloOrden: 1 } : {}), tipo, version,
    estado: 'borrador', minimoAprobatorio: 70,
    preguntas: Array.from({ length: tipo === 'cuestionario' ? 10 : 30 }, (_, i) => ({
      id: `q${i}`, enunciado: `Pregunta sintética ${i}`,
      opciones: Array.from({ length: 4 }, (_, j) => ({ id: `o${j}`, texto: `Opción sintética ${j}`, correcta: j === i % 4 })),
    })),
  };
}
function plan(evaluation = syntheticAssessment()) {
  return {
    curso: { titulo: 'Curso sintético', estado: 'borrador', proyectoFinal: {} },
    modulos: [{ orden: 1, titulo: 'Módulo sintético', activo: false }],
    lecciones: [], flashcards: [], simuladores: [],
    evaluaciones: [{ moduloOrden: evaluation.tipo === 'examen_final' ? null : 1, doc: assessmentDocument(evaluation) }],
  };
}

test('la transformación preserva texto, orden, IDs y una sola respuesta correcta, sin mutar el origen', () => {
  const source = syntheticAssessment(), before = structuredClone(source);
  const result = assessmentDocument(source);
  source.preguntas.forEach((q, i) => {
    assert.equal(result.preguntas[i].texto, q.enunciado);
    assert.equal(result.preguntas[i].id, q.id);
    assert.deepEqual(result.preguntas[i].opciones, q.opciones.map(({ id, texto }) => ({ id, texto })));
    assert.equal(result.preguntas[i].opcionCorrectaId, q.opciones.find((o) => o.correcta).id);
  });
  assert.deepEqual(source, before);
  assert.equal(result.estado, 'borrador');
  assert.doesNotMatch(JSON.stringify(result), /enunciado|"correcta"/);
});

test('rechaza claves duplicadas, cero/dos correctas, datos parciales y límites incompatibles', () => {
  for (const change of [
    (e) => e.preguntas[0].opciones.forEach((o) => { o.correcta = false; }),
    (e) => e.preguntas[0].opciones.forEach((o) => { o.correcta = true; }),
    (e) => { e.preguntas[1].id = e.preguntas[0].id; },
    (e) => { e.preguntas[0].opciones[1].id = e.preguntas[0].opciones[0].id; },
    (e) => { e.preguntas[0] = null; },
    (e) => { e.preguntas[0].opciones[0] = null; },
    (e) => { e.preguntas[0].enunciado = 'x'.repeat(4001); },
    (e) => { e.version = 2147483648; },
    (e) => { e.minimoAprobatorio = 60; },
  ]) {
    const source = syntheticAssessment(); change(source);
    assert.throws(() => assessmentDocument(source), /incompatible/);
  }
});

test('segunda y tercera carga no escriben y conservan identificadores', async () => {
  const db = createMemoryDb(), input = plan();
  await syncContent(db, input);
  const first = db.dump('evaluaciones'), writes = db.writes;
  await syncContent(db, input); await syncContent(db, input);
  assert.deepEqual(db.dump('evaluaciones'), first);
  assert.equal(db.writes, writes);
});

test('una versión cargada es inmutable incluso en borrador; una versión nueva conserva el histórico', async () => {
  const db = createMemoryDb(), source = syntheticAssessment();
  await syncContent(db, plan(source));
  const original = db.dump('evaluaciones')[0];
  source.preguntas[0].enunciado = 'Cambio sintético';
  await assert.rejects(() => syncContent(db, plan(source)), /inmutable/);
  source.version++;
  await syncContent(db, plan(source));
  assert.equal(db.dump('evaluaciones').length, 2);
  assert.deepEqual(db.dump('evaluaciones')[0], original);
});

test('el cargador no publica una versión existente ni sobrescribe un formato heredado', async () => {
  const db = createMemoryDb(), source = syntheticAssessment();
  await syncContent(db, plan(source));
  source.estado = 'publicado';
  await assert.rejects(() => syncContent(db, plan(source)), /inmutable/);
  source.estado = 'borrador';
  const existing = db.dump('evaluaciones')[0];
  await db.collection('evaluaciones').updateOne({ _id: existing._id }, { $set: { preguntas: source.preguntas } });
  await assert.rejects(() => syncContent(db, plan(source)), /inmutable/);
});

test('rechaza URI semilla de aplicación y overrides aunque el destino parezca temporal', () => {
  for (const uri of ['mongodb://localhost:27018/lethics', 'mongodb://localhost:27018/%6cethics', 'mongodb://localhost:27018/admin?dbName=lethics']) {
    assert.throws(() => assertSafeTarget(uri, 'lethics_content_test_synthetic'), /URI/);
  }
});

// Build is required for these contract checks; they exercise the actual TS domain and schema.
test('el documento adaptado es válido para Mongoose y el motor de calificación de A1/A2', async () => {
  const require = createRequire(import.meta.url);
  const { Types, model } = require('mongoose');
  const { EvaluationSchema } = require('../../dist/modules/assessments/infrastructure/assessment.schemas.js');
  const { gradeAnswers } = require('../../dist/modules/assessments/domain/assessment.js');
  const Evaluation = model('ContentCompatibility', EvaluationSchema);
  for (const tipo of ['cuestionario', 'examen_final']) {
    const doc = assessmentDocument(syntheticAssessment(tipo));
    await new Evaluation({ ...doc, cursoId: new Types.ObjectId(), moduloId: tipo === 'cuestionario' ? new Types.ObjectId() : null }).validate();
    const answers = doc.preguntas.map((q) => ({ preguntaId: q.id, opcionId: q.opcionCorrectaId }));
    assert.equal(gradeAnswers(doc.preguntas, answers).porcentaje, 100);
  }
  const { validPolicy } = require('../../dist/modules/projects/domain/project.js');
  // Proposal fixture only; hosts, file count and byte convention require team approval.
  assert.equal(validPolicy({ maxEntregas: 3, maxEnlaces: 3, hostsEnlace: ['files.example.test'], maxArchivos: 1,
    formatosArchivo: ['application/pdf', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'], maxArchivoBytes: 10_000_000 }), true);
});

test('buildPlan rechaza contenido inválido incluso si el llamador omite validateContent', () => {
  assert.throws(() => buildPlan({ curso: { titulo: '', estado: 'borrador', proyectoFinal: {} } }), /Contenido inválido/);
});

test('errores JSON y del driver no imprimen valores privados ni respuestas', () => {
  for (const name of ['SyntaxError', 'MongoServerError', 'Error']) {
    assert.doesNotMatch(explainError({ name, message: 'PRIVATE_SYNTHETIC_ANSWER token=private' }), /PRIVATE_SYNTHETIC_ANSWER|token=/);
  }
});
