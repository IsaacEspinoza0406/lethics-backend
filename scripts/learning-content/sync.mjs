// Sincronización idempotente del plan de contenido con una base compatible con el driver de MongoDB.
// No importa ningún paquete: recibe un objeto `db` con `collection(nombre)`.

const LOCAL_HOSTS = ['localhost', '127.0.0.1', '[::1]', '::1'];
// El MongoDB de Lethics escucha en 27018; el 27017 pertenece a otro proyecto y no se admite.
export const LETHICS_MONGO_PORT = '27018';
export const TEST_DB_PATTERN = /^lethics_content_test_[a-z0-9_]{1,40}$/;
export const CONTENT_COLLECTIONS = ['cursos', 'modulos', 'lecciones', 'flashcards', 'evaluaciones', 'simuladores'];

/** Rechaza cualquier destino que no sea una base de pruebas local con nombre inequívoco. */
export function assertSafeTarget(uri, dbName) {
  if (!uri) throw new Error('Falta la variable LETHICS_CONTENT_LOAD_URI.');
  if (!TEST_DB_PATTERN.test(dbName ?? '')) {
    throw new Error(`La base "${dbName}" no es válida: el nombre debe empezar con "lethics_content_test_" (solo minúsculas, números y guion bajo).`);
  }
  let url;
  try { url = new URL(uri); } catch { throw new Error('LETHICS_CONTENT_LOAD_URI no es una URI válida.'); }
  if (!['mongodb:'].includes(url.protocol)) throw new Error('Solo se admite el esquema mongodb:// (servidor local).');
  const hosts = url.host.split(',').map((h) => {
    const m = /^(\[[^\]]+\]|[^:]+)(?::(\d+))?$/.exec(h);
    return { host: m?.[1], port: m?.[2] };
  });
  if (!hosts.every((h) => LOCAL_HOSTS.includes(h.host))) throw new Error('Solo se admite un MongoDB local (localhost o 127.0.0.1).');
  if (!hosts.every((h) => h.port === LETHICS_MONGO_PORT)) {
    throw new Error(`Solo se admite el MongoDB de Lethics en el puerto ${LETHICS_MONGO_PORT} (el 27017 es de otro proyecto). Indica el puerto en el URI.`);
  }
}

/** Se niega a escribir en una base que ya contiene colecciones que no son de contenido. */
export async function assertSafeDatabase(db) {
  const names = (await db.listCollections({}, { nameOnly: true }).toArray()).map((c) => c.name);
  const foreign = names.filter((n) => !CONTENT_COLLECTIONS.includes(n));
  if (foreign.length > 0) {
    throw new Error(`La base "${db.databaseName ?? '?'}" ya contiene colecciones ajenas al contenido (${foreign.join(', ')}); no se escribe en ella.`);
  }
}

/** Forma canónica para comparar valores de MongoDB (ObjectId, fechas, objetos sin orden de claves). */
export function normalize(v) {
  if (v === undefined) return null;
  if (v === null || typeof v !== 'object') return v;
  if (v instanceof Date) return { $date: v.toISOString() };
  if (typeof v.toHexString === 'function') return { $oid: v.toHexString() };
  if (Array.isArray(v)) return v.map(normalize);
  return Object.fromEntries(Object.keys(v).sort().map((k) => [k, normalize(v[k])]));
}

const canon = (v) => JSON.stringify(normalize(v));
const keyOf = (obj, fields) => canon(Object.fromEntries(fields.map((f) => [f, obj[f]])));

const newStats = () => ({ creados: 0, actualizados: 0, sinCambios: 0 });

/**
 * Sincroniza una colección con una sola lectura y un solo bulkWrite.
 * `items` = [{ filter, doc }]: `filter` es la clave natural y `doc` el resto de los campos.
 * `fetchFilter` acota la lectura a los documentos que podrían coincidir.
 * El documento queda como espejo exacto de lo deseado: lo que cambió se actualiza y los campos
 * sobrantes se eliminan. Devuelve los `_id` en el mismo orden que `items`.
 */
async function syncDocs(coll, items, fetchFilter, stats, session) {
  if (items.length === 0) return [];
  const fields = Object.keys(items[0].filter);
  const existing = await coll.find(fetchFilter, { session }).toArray();
  const byKey = new Map();
  for (const d of existing) {
    const k = keyOf(d, fields);
    byKey.set(k, [...(byKey.get(k) ?? []), d]);
  }

  const seen = new Set();
  const ids = new Array(items.length);
  const ops = [];
  const inserts = [];
  items.forEach((item, i) => {
    const k = keyOf(item.filter, fields);
    if (seen.has(k)) throw new Error(`El plan repite la clave natural ${k}; se detiene sin escribir más.`);
    seen.add(k);
    const desired = { ...item.filter, ...item.doc };
    const found = byKey.get(k) ?? [];
    if (found.length > 1) throw new Error(`Hay ${found.length} documentos con ${k}; se detiene sin escribir más.`);
    if (found.length === 0) {
      inserts.push({ opIndex: ops.length, i });
      ops.push({ insertOne: { document: desired } });
      stats.creados++;
      return;
    }
    const { _id, ...rest } = found[0];
    ids[i] = _id;
    if (canon(rest) === canon(desired)) {
      stats.sinCambios++;
      return;
    }
    const update = { $set: desired };
    const stale = Object.keys(rest).filter((f) => !(f in desired));
    if (stale.length > 0) update.$unset = Object.fromEntries(stale.map((f) => [f, '']));
    ops.push({ updateOne: { filter: { _id }, update } });
    stats.actualizados++;
  });

  if (ops.length > 0) {
    const res = await coll.bulkWrite(ops, { ordered: true, session });
    for (const { opIndex, i } of inserts) ids[i] = res.insertedIds[opIndex];
  }
  return ids;
}

/** Índices previstos en el modelo aprobado. Se crean fuera de la transacción. */
export async function ensureContentIndexes(db) {
  await db.collection('modulos').createIndex({ cursoId: 1, orden: 1 }, { unique: true });
  await db.collection('lecciones').createIndex({ moduloId: 1, orden: 1 }, { unique: true });
}

/**
 * Carga el plan. Se puede ejecutar varias veces: no duplica documentos y solo escribe lo que cambió.
 * Las claves naturales son: curso → título; módulo → (curso, orden); lección y tarjeta → (módulo, orden);
 * evaluación → (curso, módulo, tipo, versión); simulador → (módulo, título).
 * `session` es opcional: si viene, todas las lecturas y escrituras participan en esa sesión.
 */
export async function syncContent(db, plan, { ensureIndexes = false, session } = {}) {
  const stats = Object.fromEntries(CONTENT_COLLECTIONS.map((n) => [n, newStats()]));
  const col = (n) => db.collection(n);
  if (ensureIndexes) await ensureContentIndexes(db);

  const [cursoId] = await syncDocs(
    col('cursos'),
    [{ filter: { titulo: plan.curso.titulo }, doc: { estado: plan.curso.estado, proyectoFinal: plan.curso.proyectoFinal } }],
    { titulo: plan.curso.titulo }, stats.cursos, session);

  const moduloIds = await syncDocs(
    col('modulos'),
    plan.modulos.map((m) => ({ filter: { cursoId, orden: m.orden }, doc: { titulo: m.titulo, activo: m.activo } })),
    { cursoId }, stats.modulos, session);
  const moduloId = new Map(plan.modulos.map((m, i) => [m.orden, moduloIds[i]]));
  const need = (orden) => {
    if (!moduloId.has(orden)) throw new Error(`No existe el módulo ${orden} en el plan.`);
    return moduloId.get(orden);
  };
  const enModulos = { moduloId: { $in: [...moduloId.values()] } };

  await syncDocs(
    col('lecciones'),
    plan.lecciones.map(({ moduloOrden, doc }) => { const { orden, ...rest } = doc; return { filter: { moduloId: need(moduloOrden), orden }, doc: rest }; }),
    enModulos, stats.lecciones, session);
  await syncDocs(
    col('flashcards'),
    plan.flashcards.map(({ moduloOrden, doc }) => { const { orden, ...rest } = doc; return { filter: { moduloId: need(moduloOrden), orden }, doc: rest }; }),
    enModulos, stats.flashcards, session);
  await syncDocs(
    col('evaluaciones'),
    plan.evaluaciones.map(({ moduloOrden, doc }) => {
      const { tipo, version, ...rest } = doc;
      return { filter: { cursoId, moduloId: moduloOrden === null ? null : need(moduloOrden), tipo, version }, doc: rest };
    }),
    { cursoId }, stats.evaluaciones, session);
  await syncDocs(
    col('simuladores'),
    plan.simuladores.map(({ moduloOrden, doc }) => { const { titulo, ...rest } = doc; return { filter: { moduloId: need(moduloOrden), titulo }, doc: rest }; }),
    enModulos, stats.simuladores, session);
  return stats;
}

/**
 * Igual que syncContent, pero dentro de una transacción: si algo falla, no queda contenido a medias.
 * Requiere un replica set. `client` es el MongoClient del driver.
 */
export async function syncContentAtomic(client, db, plan, { ensureIndexes = false } = {}) {
  if (ensureIndexes) await ensureContentIndexes(db);
  const session = client.startSession();
  try {
    let stats;
    // withTransaction puede repetir la función ante errores transitorios: cada intento recalcula las estadísticas.
    await session.withTransaction(async () => { stats = await syncContent(db, plan, { session }); },
      { readConcern: { level: 'snapshot' }, writeConcern: { w: 'majority' } });
    return stats;
  } finally {
    await session.endSession();
  }
}

/** Cuenta lo que quedó en la base, para comprobar el resultado. */
export async function countContent(db) {
  const out = {};
  for (const n of CONTENT_COLLECTIONS) out[n] = await db.collection(n).countDocuments({});
  return out;
}
