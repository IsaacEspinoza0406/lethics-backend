// Lectura, validación y plan de carga del contenido educativo.
// Sin dependencias: solo módulos de Node. No se conecta a ninguna base de datos.
import { readFile } from 'node:fs/promises';
import path from 'node:path';

export const MODULOS = [1, 2, 3, 4, 5];
export const ESTADOS = ['borrador', 'publicado'];
export const MODOS = ['guiado', 'ia_asistida'];
export const VARIANTES = ['nota', 'ejemplo', 'advertencia'];
export const RECURSOS = ['flashcards', 'cuestionario', 'simulador'];
export const MAX_SECCIONES = 20;
export const PREGUNTAS_CUESTIONARIO = 10;
export const PREGUNTAS_EXAMEN = 30;
export const MAX_PREGUNTAS_REPETIDAS = 5;
export const TARJETAS_POR_MODULO = 10;
export const FORMATOS_PROYECTO = ['PDF', 'DOCX'];

async function readJson(file) {
  return JSON.parse(await readFile(file, 'utf8'));
}

/** Lee todos los archivos de contenido de una carpeta (por defecto docs/contenido/json). */
export async function loadContent(dir, { includePending = false } = {}) {
  const content = {
    curso: await readJson(path.join(dir, 'curso.json')),
    modulos: await readJson(path.join(dir, 'modulos.json')),
    lecciones: {},
    flashcards: await readJson(path.join(dir, 'flashcards.json')),
  };
  for (const m of MODULOS) content.lecciones[m] = await readJson(path.join(dir, 'lecciones', `modulo-${m}.json`));
  if (includePending) {
    const p = path.join(dir, 'pendiente-reparto');
    content.evaluaciones = await readJson(path.join(p, 'evaluaciones.json'));
    content.examen = await readJson(path.join(p, 'examen-final.json'));
    content.simuladores = await readJson(path.join(p, 'simuladores.json'));
  }
  return content;
}

// ---------------------------------------------------------------- validación

const CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/;
const MARKDOWN = /\*\*|\]\(|^#{1,6}\s|`/m;
const INTERNO = /⚠|✅|ejemplo\.json|mley|\bborrador\b/i;

function text(errors, where, value, { allowEmpty = false } = {}) {
  if (typeof value !== 'string' || (!allowEmpty && value.trim() === '')) {
    errors.push(`${where}: debe ser un texto no vacío`);
    return;
  }
  if (CONTROL.test(value)) errors.push(`${where}: contiene caracteres de control`);
  if (MARKDOWN.test(value)) errors.push(`${where}: contiene marcas de Markdown`);
  if (INTERNO.test(value)) errors.push(`${where}: contiene texto interno o editorial`);
}

function onlyKeys(errors, where, obj, keys) {
  for (const k of Object.keys(obj)) if (!keys.includes(k)) errors.push(`${where}: campo no permitido "${k}"`);
  for (const k of keys) if (!(k in obj)) errors.push(`${where}: falta el campo "${k}"`);
}

function isInt(v) {
  return Number.isInteger(v);
}

function validateBlock(errors, where, b) {
  if (b === null || typeof b !== 'object' || Array.isArray(b)) return errors.push(`${where}: debe ser un objeto`);
  switch (b.tipo) {
    case 'titulo':
    case 'parrafo':
      onlyKeys(errors, where, b, ['tipo', 'texto']);
      return text(errors, `${where}.texto`, b.texto);
    case 'lista':
      onlyKeys(errors, where, b, ['tipo', 'ordenada', 'items']);
      if (typeof b.ordenada !== 'boolean') errors.push(`${where}.ordenada: debe ser booleano`);
      if (!Array.isArray(b.items) || b.items.length === 0) return errors.push(`${where}.items: debe ser una lista no vacía`);
      return b.items.forEach((it, i) => text(errors, `${where}.items[${i}]`, it));
    case 'tabla': {
      onlyKeys(errors, where, b, ['tipo', 'encabezados', 'filas']);
      if (!Array.isArray(b.encabezados) || b.encabezados.length === 0) return errors.push(`${where}.encabezados: debe ser una lista no vacía`);
      b.encabezados.forEach((h, i) => text(errors, `${where}.encabezados[${i}]`, h, { allowEmpty: true }));
      if (!Array.isArray(b.filas) || b.filas.length === 0) return errors.push(`${where}.filas: debe ser una lista no vacía`);
      return b.filas.forEach((f, r) => {
        if (!Array.isArray(f) || f.length !== b.encabezados.length) return errors.push(`${where}.filas[${r}]: debe tener ${b.encabezados.length} celdas`);
        f.forEach((c, i) => text(errors, `${where}.filas[${r}][${i}]`, c, { allowEmpty: true }));
      });
    }
    case 'destacado':
      onlyKeys(errors, where, b, ['tipo', 'variante', 'texto']);
      if (!VARIANTES.includes(b.variante)) errors.push(`${where}.variante: debe ser ${VARIANTES.join(', ')}`);
      return text(errors, `${where}.texto`, b.texto);
    case 'recurso':
      onlyKeys(errors, where, b, ['tipo', 'recurso']);
      if (!RECURSOS.includes(b.recurso)) errors.push(`${where}.recurso: debe ser ${RECURSOS.join(', ')}`);
      return;
    default:
      errors.push(`${where}.tipo: "${b.tipo}" no es un tipo de bloque aprobado`);
  }
}

function validatePreguntas(errors, where, preguntas, esperado) {
  if (!Array.isArray(preguntas) || preguntas.length !== esperado) {
    errors.push(`${where}: debe tener ${esperado} preguntas (tiene ${Array.isArray(preguntas) ? preguntas.length : 'ninguna'})`);
    if (!Array.isArray(preguntas)) return;
  }
  const ids = new Set();
  preguntas.forEach((q, i) => {
    const w = `${where}[${i}]`;
    onlyKeys(errors, w, q, ['id', 'enunciado', 'opciones']);
    text(errors, `${w}.id`, q.id);
    if (ids.has(q.id)) errors.push(`${w}.id: repetido "${q.id}"`);
    ids.add(q.id);
    text(errors, `${w}.enunciado`, q.enunciado);
    if (!Array.isArray(q.opciones) || q.opciones.length !== 4) return errors.push(`${w}.opciones: debe tener 4 opciones`);
    const oids = new Set();
    let correctas = 0;
    q.opciones.forEach((o, j) => {
      const wo = `${w}.opciones[${j}]`;
      onlyKeys(errors, wo, o, ['id', 'texto', 'correcta']);
      text(errors, `${wo}.id`, o.id);
      text(errors, `${wo}.texto`, o.texto);
      if (typeof o.correcta !== 'boolean') errors.push(`${wo}.correcta: debe ser booleano`);
      if (o.correcta === true) correctas++;
      if (oids.has(o.id)) errors.push(`${wo}.id: repetido "${o.id}"`);
      oids.add(o.id);
    });
    if (correctas !== 1) errors.push(`${w}: debe tener exactamente una opción correcta (tiene ${correctas})`);
  });
}

function validateEvaluacion(errors, where, ev, { tipo, preguntas }) {
  const keys = ['tipo', 'version', 'estado', 'minimoAprobatorio', 'preguntas'];
  const extra = tipo === 'cuestionario' ? ['moduloOrden'] : [];
  onlyKeys(errors, where, ev, [...keys, ...extra]);
  if (ev.tipo !== tipo) errors.push(`${where}.tipo: debe ser "${tipo}"`);
  if (!isInt(ev.version) || ev.version < 1) errors.push(`${where}.version: debe ser un entero positivo`);
  if (!ESTADOS.includes(ev.estado)) errors.push(`${where}.estado: debe ser ${ESTADOS.join(' o ')}`);
  if (ev.minimoAprobatorio !== 70) errors.push(`${where}.minimoAprobatorio: debe ser 70`);
  validatePreguntas(errors, `${where}.preguntas`, ev.preguntas, preguntas);
}

/** Devuelve la lista de errores de validación (vacía si el contenido es válido). */
export function validateContent(content, { includePending = false } = {}) {
  const errors = [];
  // curso
  const c = content.curso;
  onlyKeys(errors, 'curso', c, ['titulo', 'estado', 'proyectoFinal']);
  text(errors, 'curso.titulo', c.titulo);
  if (!ESTADOS.includes(c.estado)) errors.push(`curso.estado: debe ser ${ESTADOS.join(' o ')}`);
  const pf = c.proyectoFinal ?? {};
  onlyKeys(errors, 'curso.proyectoFinal', pf, ['instrucciones', 'requisitos', 'formatosPermitidos']);
  text(errors, 'curso.proyectoFinal.instrucciones', pf.instrucciones);
  if (!Array.isArray(pf.requisitos) || pf.requisitos.length === 0) errors.push('curso.proyectoFinal.requisitos: debe ser una lista no vacía');
  else pf.requisitos.forEach((r, i) => text(errors, `curso.proyectoFinal.requisitos[${i}]`, r));
  if (!Array.isArray(pf.formatosPermitidos) || pf.formatosPermitidos.some((f) => !FORMATOS_PROYECTO.includes(f)) || pf.formatosPermitidos.length === 0) {
    errors.push(`curso.proyectoFinal.formatosPermitidos: solo ${FORMATOS_PROYECTO.join(' y ')}`);
  }
  // módulos
  if (!Array.isArray(content.modulos) || content.modulos.length !== MODULOS.length) errors.push(`modulos: debe haber ${MODULOS.length}`);
  else {
    content.modulos.forEach((m, i) => {
      const w = `modulos[${i}]`;
      onlyKeys(errors, w, m, ['orden', 'titulo', 'activo']);
      if (m.orden !== i + 1) errors.push(`${w}.orden: debe ser ${i + 1}`);
      text(errors, `${w}.titulo`, m.titulo);
      if (typeof m.activo !== 'boolean') errors.push(`${w}.activo: debe ser booleano`);
    });
  }
  // lecciones
  for (const m of MODULOS) {
    const f = content.lecciones?.[m];
    const w = `lecciones[modulo ${m}]`;
    if (!f || f.moduloOrden !== m || !Array.isArray(f.lecciones)) { errors.push(`${w}: archivo inválido`); continue; }
    onlyKeys(errors, w, f, ['moduloOrden', 'lecciones']);
    if (f.lecciones.length !== 10) errors.push(`${w}: debe tener 10 lecciones (tiene ${f.lecciones.length})`);
    f.lecciones.forEach((l, i) => {
      const wl = `${w}.L${i + 1}`;
      onlyKeys(errors, wl, l, ['orden', 'titulo', 'version', 'activo', 'secciones']);
      if (l.orden !== i + 1) errors.push(`${wl}.orden: debe ser ${i + 1}`);
      text(errors, `${wl}.titulo`, l.titulo);
      if (!isInt(l.version) || l.version < 1) errors.push(`${wl}.version: debe ser un entero positivo`);
      if (typeof l.activo !== 'boolean') errors.push(`${wl}.activo: debe ser booleano`);
      if (!Array.isArray(l.secciones) || l.secciones.length === 0) return errors.push(`${wl}.secciones: debe tener contenido`);
      if (l.secciones.length > MAX_SECCIONES) errors.push(`${wl}.secciones: máximo ${MAX_SECCIONES} (tiene ${l.secciones.length})`);
      l.secciones.forEach((b, j) => validateBlock(errors, `${wl}.secciones[${j}]`, b));
      const recursos = l.secciones.filter((b) => b.tipo === 'recurso').map((b) => b.recurso);
      if (l.orden === 9 && !recursos.includes('simulador')) errors.push(`${wl}: la lección 9 debe incluir el recurso "simulador"`);
      if (l.orden === 10 && !recursos.includes('cuestionario')) errors.push(`${wl}: la lección 10 debe incluir el recurso "cuestionario"`);
    });
  }
  // flashcards
  if (!Array.isArray(content.flashcards) || content.flashcards.length !== MODULOS.length) errors.push('flashcards: debe haber un mazo por módulo');
  else {
    content.flashcards.forEach((mz, i) => {
      const w = `flashcards[modulo ${i + 1}]`;
      onlyKeys(errors, w, mz, ['moduloOrden', 'tarjetas']);
      if (mz.moduloOrden !== i + 1) errors.push(`${w}.moduloOrden: debe ser ${i + 1}`);
      if (!Array.isArray(mz.tarjetas) || mz.tarjetas.length !== TARJETAS_POR_MODULO) return errors.push(`${w}: debe tener ${TARJETAS_POR_MODULO} tarjetas`);
      const conceptos = new Set();
      mz.tarjetas.forEach((t, k) => {
        const wt = `${w}[${k}]`;
        onlyKeys(errors, wt, t, ['orden', 'concepto', 'definicion']);
        if (t.orden !== k + 1) errors.push(`${wt}.orden: debe ser ${k + 1}`);
        text(errors, `${wt}.concepto`, t.concepto);
        text(errors, `${wt}.definicion`, t.definicion);
        if (conceptos.has(t.concepto)) errors.push(`${wt}.concepto: repetido`);
        conceptos.add(t.concepto);
      });
    });
  }
  if (!includePending) return errors;
  // evaluaciones, examen y simuladores
  const cuestionarios = content.evaluaciones ?? [];
  if (cuestionarios.length !== MODULOS.length) errors.push(`evaluaciones: debe haber ${MODULOS.length} cuestionarios`);
  const enunciados = new Set();
  cuestionarios.forEach((ev, i) => {
    if (ev.moduloOrden !== i + 1) errors.push(`evaluaciones[${i}].moduloOrden: debe ser ${i + 1}`);
    validateEvaluacion(errors, `evaluaciones[modulo ${i + 1}]`, ev, { tipo: 'cuestionario', preguntas: PREGUNTAS_CUESTIONARIO });
    (ev.preguntas ?? []).forEach((q) => enunciados.add(q.enunciado));
  });
  const ex = content.examen ?? {};
  validateEvaluacion(errors, 'examen', ex, { tipo: 'examen_final', preguntas: PREGUNTAS_EXAMEN });
  const repetidas = (ex.preguntas ?? []).filter((q) => enunciados.has(q.enunciado)).length;
  if (repetidas > MAX_PREGUNTAS_REPETIDAS) errors.push(`examen: ${repetidas} preguntas repiten las de los cuestionarios (máximo ${MAX_PREGUNTAS_REPETIDAS})`);
  const sims = content.simuladores ?? [];
  if (sims.length !== MODULOS.length) errors.push(`simuladores: debe haber ${MODULOS.length}`);
  sims.forEach((s, i) => {
    const w = `simuladores[${i}]`;
    onlyKeys(errors, w, s, ['moduloOrden', 'titulo', 'version', 'contexto', 'consigna', 'modo', 'activo']);
    if (s.moduloOrden !== i + 1) errors.push(`${w}.moduloOrden: debe ser ${i + 1}`);
    text(errors, `${w}.titulo`, s.titulo);
    text(errors, `${w}.contexto`, s.contexto);
    text(errors, `${w}.consigna`, s.consigna);
    if (!MODOS.includes(s.modo)) errors.push(`${w}.modo: debe ser ${MODOS.join(' o ')}`);
    if (!isInt(s.version) || s.version < 1) errors.push(`${w}.version: debe ser un entero positivo`);
    if (typeof s.activo !== 'boolean') errors.push(`${w}.activo: debe ser booleano`);
  });
  return errors;
}

// ---------------------------------------------------------------- plan de carga

/**
 * Documentos de MongoDB sin identificadores: las referencias (cursoId, moduloId) las resuelve la
 * sincronización. `moduloOrden` es solo una clave de trabajo y no se guarda.
 */
export function buildPlan(content, { includePending = false } = {}) {
  const plan = {
    curso: { titulo: content.curso.titulo, estado: content.curso.estado, proyectoFinal: content.curso.proyectoFinal },
    modulos: content.modulos.map((m) => ({ orden: m.orden, titulo: m.titulo, activo: m.activo })),
    lecciones: [],
    flashcards: [],
    evaluaciones: [],
    simuladores: [],
  };
  for (const m of MODULOS) {
    for (const l of content.lecciones[m].lecciones) {
      plan.lecciones.push({ moduloOrden: m, doc: { orden: l.orden, titulo: l.titulo, version: l.version, secciones: l.secciones, activo: l.activo } });
    }
  }
  for (const mz of content.flashcards) {
    for (const t of mz.tarjetas) plan.flashcards.push({ moduloOrden: mz.moduloOrden, doc: { orden: t.orden, concepto: t.concepto, definicion: t.definicion } });
  }
  if (includePending) {
    for (const ev of content.evaluaciones) {
      plan.evaluaciones.push({ moduloOrden: ev.moduloOrden, doc: { tipo: ev.tipo, version: ev.version, minimoAprobatorio: ev.minimoAprobatorio, preguntas: ev.preguntas, estado: ev.estado } });
    }
    const ex = content.examen;
    plan.evaluaciones.push({ moduloOrden: null, doc: { tipo: ex.tipo, version: ex.version, minimoAprobatorio: ex.minimoAprobatorio, preguntas: ex.preguntas, estado: ex.estado } });
    for (const s of content.simuladores) {
      plan.simuladores.push({ moduloOrden: s.moduloOrden, doc: { titulo: s.titulo, version: s.version, contexto: s.contexto, consigna: s.consigna, modo: s.modo, activo: s.activo } });
    }
  }
  return plan;
}
