# Carga del contenido educativo

Script que pasa el contenido de los JSON (`docs/contenido/json`) a MongoDB. Son dos etapas: primero se **valida** (sin base de datos) y después se **carga** (solo a una base de pruebas local).

No añade dependencias, no modifica `package.json` ni ningún archivo compartido, y no usa Git.

## Qué carga
`cursos` (con `proyectoFinal`), `modulos`, `lecciones` (con `secciones[]`) y `flashcards`. Con `--include-pending` también `evaluaciones` (5 cuestionarios y el examen final) y `simuladores`, que implementa Backend A.

Los `_id`, `cursoId` y `moduloId` los resuelve el script. `moduloOrden` es una clave de trabajo y no se guarda.

## Cómo se usa

Requiere Node 22 (el proyecto pide `>=22 <23`) y haber ejecutado `npm ci`. Con fnm: `fnm exec --using=22.23.5 node ...`.

Validar (no necesita MongoDB):

```powershell
node scripts/load-learning-content.mjs --include-pending
```

Cargar en una base de pruebas local (el URI es tuyo; no lo pegues en archivos del repo):

```powershell
$env:LETHICS_CONTENT_LOAD_URI = "<URI de tu MongoDB local, con el puerto 27018>"
node scripts/load-learning-content.mjs --include-pending --apply --db lethics_content_test_mia --ensure-indexes
```

Opciones: `--dir <carpeta>` (otra carpeta de JSON), `--include-pending`, `--apply --db <nombre>`, `--ensure-indexes`, `--no-transaction` (solo para una base de pruebas desechable sin replica set).

Pruebas:

```powershell
# Unitarias (no necesitan MongoDB)
node --test scripts/learning-content/loader.test.mjs
# Todas, incluidas las de integración (se omiten si no hay LETHICS_CONTENT_LOAD_URI)
node --test "scripts/learning-content/*.test.mjs"
```

## Garantías
- **Idempotente.** Cada documento tiene una clave natural: curso → título; módulo → (curso, orden); lección y tarjeta → (módulo, orden); evaluación → (curso, módulo, tipo, versión); simulador → (módulo, título). Una segunda carga no escribe nada; si cambió un documento, lo actualiza; si encuentra duplicados, se detiene sin escribir.
- **Espejo exacto.** Un documento existente se compara completo (sin `_id`). Si cambió, se actualiza y se **eliminan los campos que ya no están en el JSON**. El script asume que es el único que escribe en estas colecciones.
- **Atómica.** Por defecto toda la carga va en una transacción (requiere replica set): si algo falla, no queda contenido a medias.
- **Eficiente.** Una lectura y un `bulkWrite` por colección (6 en total), en lugar de una consulta por documento.
- **Validada.** Antes de escribir revisa el contrato aprobado: 6 tipos de bloque sin campos extra, máximo 20 secciones, 10 lecciones por módulo, 10 tarjetas, 10 preguntas por cuestionario (una sola correcta), 30 en el examen (como máximo 5 repetidas), `estado` y `modo` válidos, sin Markdown, sin caracteres de control y sin notas internas (⚠️, ejemplo.json, mley).
- **Solo el MongoDB de Lethics.** `--apply` exige un MongoDB local **en el puerto 27018** (el 27017 es de otro proyecto) y una base que empiece con `lethics_content_test_`. No acepta `lethics`, y se niega a escribir en una base que ya tenga colecciones ajenas al contenido.
- **Índices.** `--ensure-indexes` crea solo los dos previstos en el modelo (`modulos {cursoId, orden}` y `lecciones {moduloId, orden}`, únicos), y solo en bases de pruebas. Se crean antes de la transacción.
- **Errores claros.** Los fallos de conexión, autenticación, permisos, claves duplicadas y transacciones se explican en español y nunca muestran el URI.

## Qué no hace (todavía)
- No carga a la base de desarrollo ni a producción: eso requiere aprobación del equipo.
- No define esquemas de Mongoose ni endpoints; eso es el incremento B1.
- No borra la base de pruebas que crea: las pruebas de integración borran solo la suya.
- Las lecciones, módulos y simuladores quedan con `activo: false` y todo en `borrador` hasta publicar.

## Verificado
Probado contra MongoDB 8.0.38 con replica set (puerto 27018): carga, repetición sin cambios, tipos (Int32, ObjectId, `moduloId: null` en el examen), índices únicos, actualización, eliminación de campos sobrantes y reversión de una carga fallida.
