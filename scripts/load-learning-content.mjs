#!/usr/bin/env node
// Carga el contenido educativo (JSON) a MongoDB. Por defecto solo VALIDA; no escribe nada.
//
//   node scripts/load-learning-content.mjs                         validar (sin base de datos)
//   node scripts/load-learning-content.mjs --include-pending       validar también evaluaciones, examen y simuladores
//   LETHICS_CONTENT_LOAD_URI=mongodb://... node scripts/load-learning-content.mjs --apply --db lethics_content_test_xxx
//
// Seguridad: --apply solo funciona contra el MongoDB local de Lethics (puerto 27018) y una base cuyo nombre
// empiece con "lethics_content_test_". No toca la base `lethics` ni escribe en bases con colecciones ajenas.
// La carga va en una transacción (requiere replica set). No usa Git ni crea índices salvo con --ensure-indexes.
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadContent, validateContent, buildPlan } from './learning-content/content.mjs';
import { syncContent, syncContentAtomic, countContent, assertSafeTarget, assertSafeDatabase, ensureContentIndexes } from './learning-content/sync.mjs';
import { explainError } from './learning-content/errors.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function parseArgs(argv) {
  const args = { dir: path.join(root, 'docs', 'contenido', 'json'), apply: false, includePending: false, ensureIndexes: false, transaction: true, db: undefined, help: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--apply') args.apply = true;
    else if (a === '--include-pending') args.includePending = true;
    else if (a === '--ensure-indexes') args.ensureIndexes = true;
    else if (a === '--no-transaction') args.transaction = false;
    else if (a === '--dir') args.dir = path.resolve(argv[++i] ?? '');
    else if (a === '--db') args.db = argv[++i];
    else if (a === '--help' || a === '-h') args.help = true;
    else throw new Error(`Argumento desconocido: ${a}`);
  }
  return args;
}

function printStats(stats) {
  for (const [name, s] of Object.entries(stats)) {
    console.log(`  ${name.padEnd(13)} creados ${String(s.creados).padStart(3)} · actualizados ${String(s.actualizados).padStart(3)} · sin cambios ${String(s.sinCambios).padStart(3)}`);
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log('Uso: node scripts/load-learning-content.mjs [--dir <carpeta>] [--include-pending] [--apply --db <nombre>] [--ensure-indexes] [--no-transaction]');
    return;
  }
  const content = await loadContent(args.dir, { includePending: args.includePending });
  const errors = validateContent(content, { includePending: args.includePending });
  if (errors.length > 0) {
    console.error(`Validación fallida (${errors.length} errores):`);
    for (const e of errors.slice(0, 50)) console.error(`  - ${e}`);
    if (errors.length > 50) console.error(`  ... y ${errors.length - 50} más`);
    process.exitCode = 1;
    return;
  }
  const plan = buildPlan(content, { includePending: args.includePending });
  console.log(`Validación correcta: 1 curso, ${plan.modulos.length} módulos, ${plan.lecciones.length} lecciones, ${plan.flashcards.length} tarjetas` +
    (args.includePending ? `, ${plan.evaluaciones.length} evaluaciones, ${plan.simuladores.length} simuladores.` : '.'));
  if (!args.apply) {
    console.log('Modo de validación: no se escribió nada en ninguna base de datos.');
    return;
  }
  const uri = process.env.LETHICS_CONTENT_LOAD_URI;
  assertSafeTarget(uri, args.db);
  const { default: mongoose } = await import('mongoose');
  const conn = await mongoose.createConnection(uri, { dbName: args.db, serverSelectionTimeoutMS: 5000 }).asPromise();
  try {
    await assertSafeDatabase(conn.db);
    console.log(`Cargando en la base de pruebas "${args.db}" ${args.transaction ? '(en una transacción)' : '(sin transacción)'}...`);
    const started = Date.now();
    let stats;
    if (args.transaction) {
      stats = await syncContentAtomic(conn.getClient(), conn.db, plan, { ensureIndexes: args.ensureIndexes });
    } else {
      if (args.ensureIndexes) await ensureContentIndexes(conn.db);
      stats = await syncContent(conn.db, plan);
    }
    printStats(stats);
    console.log('Total en la base:', JSON.stringify(await countContent(conn.db)));
    console.log(`Tiempo de la carga: ${((Date.now() - started) / 1000).toFixed(2)} s`);
  } finally {
    await conn.close();
  }
}

main().catch((err) => {
  console.error(`Error: ${explainError(err)}`);
  process.exitCode = 1;
});
