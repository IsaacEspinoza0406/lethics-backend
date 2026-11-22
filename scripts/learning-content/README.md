# Carga del contenido educativo

Script que pasa el contenido de los JSON (`docs/contenido/json`) a MongoDB. Son dos etapas: primero se **valida** (sin base de datos) y después se **carga** (solo a una base de pruebas local).

No añade dependencias y no usa Git. El contenido académico, respuestas y notas editoriales permanecen en `docs/contenido/`, ignorado por Git; no se copian a esta guía ni a fixtures versionadas.

## Qué carga
`cursos` (con `proyectoFinal`), `modulos`, `lecciones` (con `secciones[]`) y `flashcards`. Con `--include-pending` también `evaluaciones` (5 cuestionarios y el examen final) y `simuladores`. Cargar datos no implementa servicios HTTP ni un motor de simuladores o IA; estos últimos requieren coordinación con Backend B.

Los `_id`, `cursoId` y `moduloId` los resuelve el script. `moduloOrden` es una clave de trabajo y no se guarda.

## Cómo se usa

Requiere Node 22 (el proyecto pide `>=22 <23`) y haber ejecutado `npm ci`. Con fnm: `fnm exec --using=22.23.5 node ...`.

Validar (no necesita MongoDB):

```powershell
node scripts/load-learning-content.mjs --include-pending
```

Cargar en una base de pruebas local (el URI es tuyo; no lo pegues en archivos del repo):

```powershell
$env:LETHICS_CONTENT_LOAD_URI = "<URI privado local, puerto 27018, base semilla admin>"
$testDb = 'lethics_content_test_' + [guid]::NewGuid().ToString('N')
node scripts/load-learning-content.mjs --include-pending --apply --db $testDb --ensure-indexes
```

Opciones: `--dir <carpeta>` (otra carpeta de JSON), `--include-pending`, `--apply --db <nombre>`, `--ensure-indexes`, `--no-transaction` (solo para una base de pruebas desechable sin replica set; puede dejar escrituras parciales). Para probar rollback, utiliza las integraciones con replica set. La CLI conserva la base de prueba para inspección; su limpieza manual requiere verificar el nombre y la propiedad, nunca usar comodines. Las pruebas automatizadas administran su propia conexión y limpieza.

Pruebas:

```powershell
# Unitarias (no necesitan MongoDB)
npm.cmd run build
node --test scripts/learning-content/loader.test.mjs scripts/learning-content/compatibility.test.mjs
# Todas, incluidas las de integración (se omiten si no hay LETHICS_CONTENT_LOAD_URI)
node --test "scripts/learning-content/*.test.mjs"
```

## Garantías
- **Idempotente.** Cada documento tiene una clave natural: curso → título; módulo → (curso, orden); lección y tarjeta → (módulo, orden); evaluación → (curso, módulo, tipo, versión); simulador → (módulo, título). Una segunda carga no escribe nada. El proceso requiere un único operador/escritor; no ofrece exclusión entre dos cargadores concurrentes. Cambiar títulos usados como clave puede crear otro curso o simulador y requiere coordinación.
- **Representación canónica.** El espejo exacto se aplica al plan validado y adaptado, no a los JSON editoriales crudos. Para colecciones distintas de evaluaciones, los campos sobrantes se eliminan; esa estrategia solo es admisible en estas bases aisladas de contenido. No aplicar a una base compartida con otros escritores.
- **Evaluaciones inmutables.** Una evaluación existente idéntica no se escribe. Si difiere, incluso estando en borrador, se rechaza: se necesita otra versión explícita en la fuente. Las versiones anteriores y sus `_id` se conservan. Tampoco se reemplaza automáticamente un documento heredado con preguntas editoriales; su conversión en una base de aplicación exige un procedimiento autorizado, fuera de este script. No hay escritura ni eliminación de intentos.
- **Atómica.** Por defecto toda la carga va en una transacción (requiere replica set): si algo falla, no queda contenido a medias.
- **Eficiente.** Una lectura y un `bulkWrite` por colección (6 en total), en lugar de una consulta por documento.
- **Validada.** Antes de escribir revisa el contrato aprobado: 6 tipos de bloque sin campos extra, máximo 20 secciones, 10 lecciones por módulo, 10 tarjetas, 10 preguntas por cuestionario (una sola correcta), 30 en el examen (como máximo 5 repetidas), `estado` y `modo` válidos, sin Markdown, sin caracteres de control y sin notas internas (⚠️, ejemplo.json, mley).
- **Solo el MongoDB de Lethics.** `--apply` exige un MongoDB local **en el puerto 27018** y una base que empiece con `lethics_content_test_`. Rechaza `lethics` también en la URI semilla, overrides `dbName` y bases con colecciones ajenas al contenido, incluidas las de intentos. La integración genera un UUID por ejecución, comprueba ausencia previa y limpia solo mediante la conexión, cliente y base capturados al crearla; verifica su desaparición al terminar.
- **Índices.** `--ensure-indexes` crea solo los dos previstos en el modelo (`modulos {cursoId, orden}` y `lecciones {moduloId, orden}`, únicos), y solo en bases de pruebas. Se crean antes de la transacción.
- **Errores sanitizados.** Los fallos conocidos se explican sin credenciales ni preguntas. Los errores desconocidos y de parsing omiten el mensaje original, que podría incluir respuestas privadas.

## Transformación de evaluaciones

La única fuente académica sigue siendo el JSON privado. [content.mjs](content.mjs) valida y transforma cada pregunta: conserva `id`, convierte `enunciado` en `texto`, copia únicamente `id/texto` de cada opción y toma el ID de la única opción con `correcta: true` para `opcionCorrectaId`. No recorta ni reordena texto, IDs u opciones. Rechaza IDs repetidos, cero o varias respuestas correctas, límites incompatibles y versiones fuera de Int32. Se conserva versión, estado, tipo y umbral del 70%.

El esquema real de [evaluaciones](../../src/modules/assessments/infrastructure/assessment.schemas.ts) **no exige ni admite `titulo`**: no se inventa ese campo. Los títulos de curso/módulo permanecen donde corresponden. Las referencias principales se resuelven como ObjectId; el examen usa el mismo curso y `moduloId: null`. Se validan cinco cuestionarios de diez preguntas y un examen de treinta.

El JSON adaptado contiene claves de calificación privadas para uso del servidor. No debe entregarse directamente al frontend; AssessmentsModule usa una respuesta explícita sin `opcionCorrectaId`. Las pruebas comprueban compatibilidad con Mongoose y el motor de calificación; la suite HTTP existente cubre privacidad, versiones, historial y permisos. No se cambian estados de publicación durante esta integración.

## Política del proyecto y contratos pendientes

La [guía de integración](../../INTEGRACION_BACKEND_EDUCATIVO.md) propone la traducción estructurada de PDF/DOCX, 10 MB, tres enlaces y dos reentregas. El JSON del curso no incluye todos los campos exigidos por ProjectPolicy: se conserva sin modificaciones. No se interpretan instrucciones o requisitos de texto libre como configuración ejecutable. Faltan cantidad máxima de archivos, hosts permitidos y precisión del límite en bytes, además de un servicio de cursos que autorice al estudiante y un almacenamiento confiable.

AssessmentContextPort compone AssessmentProgressPort con ProjectSubmissionPort; este último sí consulta entregas reales. AssessmentResultsPort expone resultados sin alterar progreso. Los proveedores de cursos/progreso permanecen en 503 hasta contar con implementaciones verificables: ni cargar el contenido ni registrar una entrega habilitan por sí solos el examen. No se añaden colecciones ni proveedores ficticios.

Los cinco simuladores se validan con `moduloId`, título, versión, contexto, consigna, modo y activo según el modelo documental. Su carga no implementa el motor, respuestas, IA, retroalimentación o progreso. No se cambian sus estados ni se conectan servicios inexistentes.

## Qué no hace (todavía)
- No carga a la base de desarrollo ni a producción: eso requiere aprobación del equipo.
- No implementa servicios NestJS de cursos/progreso ni conecta proveedores inexistentes.
- No borra la base de pruebas que crea: las pruebas de integración borran solo la suya.
- Conserva `activo` y `estado` exactamente como vienen en las fuentes; el contenido vigente está inactivo/en borrador. No es una herramienta de publicación ni de migración real.

## Verificado
Las pruebas del cargador se ejecutan con `node --test` y no están incluidas en Jest. Las de integración requieren la URI y el contenido privado; si faltan se omiten explícitamente. Las pruebas sintéticas de compatibilidad necesitan un build previo, pero no el material académico. Para la regresión HTTP completa se conserva `node scripts/mailpit.cjs suite`, con MongoDB/Redis aislados y Mailpit temporal.
