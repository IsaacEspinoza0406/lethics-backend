# Integración del backend educativo

Guía de los contratos implementados entre evaluaciones, proyectos y los futuros módulos de cursos/progreso. Backend B ya aportó datos académicos privados y un cargador de MongoDB; todavía no existen módulos NestJS de cursos o progreso en esta rama. Las fixtures demuestran el contrato, no una integración real con dichos servicios. La [guía del cargador](scripts/learning-content/README.md) documenta la adaptación del contenido y sus límites de seguridad.

## Responsabilidades y dependencias

- Backend A mantiene identidad/seguridad, evaluaciones, intentos, examen y entregas. Calcula resultados y aplica propiedad, idempotencia y límites.
- Backend B mantiene cursos, módulos, lecciones, flashcards, simuladores/IA, progreso y actividad. Verifica relaciones educativas y finalización de los módulos; decide cómo incorporar los resultados al progreso global.
- Frontend consume HTTP con la identidad autenticada. No decide rol, porcentaje, aprobación, progreso o validez de una entrega.
- El proveedor de archivos sigue pendiente de aprobación. No hay endpoint de carga ni almacenamiento simulado habilitado en la aplicación real.

Dependencia actual: [AssessmentsModule](src/modules/assessments/assessments.module.ts) importa [ProjectsModule](src/modules/projects/projects.module.ts), que exporta el puerto de consulta de entregas. Projects no importa Assessments. Ambos reutilizan la autenticación global. No consultan colecciones internas de cursos/progreso ni las duplican.

## Contratos reales

Los identificadores de documentos y referencias son ObjectId en MongoDB y cadenas hexadecimales canónicas de 24 caracteres en estos contratos. Los IDs internos de preguntas/opciones son cadenas estables dentro de cada versión. Los adaptadores reciben identidad y referencias resueltas por el servidor.

### Disponibilidad y progreso

[AssessmentContextPort](src/modules/assessments/application/assessment-context.ts) expone:

- `isAvailable(context: Readonly<AssessmentContext>): Promise<boolean>`.
- `finalExamEligibility(context: Readonly<FinalExamContext>): Promise<FinalExamEligibility>`. Tiene implementación predeterminada que rechaza finales sin integración.

```typescript
interface AssessmentContext {
  usuarioId: string;
  evaluacionId: string;
  cursoId: string;
  moduloId: string;
  version: number;
}
type FinalExamContext = Omit<AssessmentContext, 'moduloId'> & { moduloId: null };
interface FinalExamEligibility {
  cursoId: string;
  modulosCompletados: readonly string[];
  proyectoEntregado: boolean;
}
```

La composición real [ProjectAssessmentContext](src/modules/assessments/application/project-assessment-context.ts) delega en **AssessmentProgressPort**:

- `isQuizAvailable(context: Readonly<AssessmentContext>): Promise<boolean>`.
- `completedModules(context: Readonly<FinalExamContext>): Promise<{ cursoId: string; modulosCompletados: readonly string[] }>`.

Backend B debe acreditar existencia y pertenencia módulo/curso, disponibilidad para ese estudiante y los IDs distintos de los módulos realmente completados del mismo curso. No basta un contador ni una lista del cliente. Una lista parcial válida representa requisitos incompletos; un fallo de lectura debe lanzar error, nunca devolver datos inventados o una aprobación por defecto.

El puente obtiene `proyectoEntregado` desde ProjectSubmissionPort, no desde progreso ni desde HTTP. Conservar esta composición al conectar Backend B. El proveedor actual UnintegratedAssessmentProgress devuelve 503 para cuestionarios y finales; no se sustituye con fixtures en producción.

### Instrucciones y política del proyecto

[ProjectCoursePort](src/modules/projects/application/project-ports.ts) define `describe(owner: Readonly<ProjectOwner>): Promise<CourseProject | null>`.

```typescript
interface ProjectOwner { usuarioId: string; cursoId: string }
interface CourseProject {
  cursoId: string;
  instrucciones: string;
  politica: ProjectPolicy;
}
interface ProjectPolicy {
  maxEntregas: number;
  maxEnlaces: number;
  hostsEnlace: readonly string[];
  maxArchivos: number;
  formatosArchivo: readonly string[];
  maxArchivoBytes: number;
}
```

El adaptador debe comprobar que el curso y su proyecto existen y están disponibles para ese estudiante. `null` significa no disponible, no una caída del servicio. Debe retornar el curso solicitado y una política completa aprobada por el equipo, nunca límites del frontend. El proveedor actual UnintegratedProjectCourse devuelve 503.

`maxEntregas` incluye la primera entrega y las reentregas. `hostsEnlace` autoriza hosts HTTPS exactos en minúsculas, sin comodines ni autorización por sufijo. Los formatos son MIME confiables y los tamaños, bytes exactos. No hay valores académicos predeterminados. Los límites técnicos del [dominio](src/modules/projects/domain/project.ts) incluyen 20 evidencias y elementos por lista, 2048 caracteres por URL y contadores Int32; no equivalen a una cuota académica aprobada.

Las fuentes académicas locales confirman PDF/DOCX, 10 MB por archivo, tres enlaces y una entrega inicial más dos reentregas. La traducción propuesta para el futuro adaptador es explícita: `maxEntregas: 3`, `maxEnlaces: 3`, formatos MIME `application/pdf` y `application/vnd.openxmlformats-officedocument.wordprocessingml.document`. El equipo debe precisar la cantidad de archivos permitidos, los hosts autorizados y si «10 MB» significa 10 000 000 o 10 485 760 bytes antes de completar `maxArchivos`, `hostsEnlace` y `maxArchivoBytes`.

Actualmente `cursos.proyectoFinal` solo contiene `instrucciones`, `requisitos[]` y `formatosPermitidos[]`. No se extrae una política confiable de su texto libre ni se añaden campos al curso. El futuro adaptador deberá combinar formatos estructurados validados con una política aprobada y explícita, comprobar disponibilidad y pertenencia, y rechazar configuraciones incompletas. Esta propuesta no habilita entregas: ProjectCoursePort conserva su proveedor 503 y ProjectFilePort sigue sin almacenamiento real.

### Archivos y evidencia

[ProjectFilePort](src/modules/projects/application/project-ports.ts) define `verify(owner: Readonly<ProjectOwner>, referencia: string): Promise<VerifiedProjectFile | null>`.

```typescript
interface FileMetadata {
  nombre: string;
  mime: string;
  bytes: number;
  sha256: string;
}
interface VerifiedProjectFile extends ProjectOwner, FileMetadata {
  referencia: string;
}
```

Un adaptador real solo puede retornar archivos efectivamente recibidos, inspeccionados y autorizados para ese usuario/curso. Debe comprobar contenido real y tamaño, no únicamente extensión/MIME declarado; referencias opacas, durables e inmutables, sin rutas arbitrarias o URLs firmadas efímeras. `null` rechaza referencias inexistentes/ajenas; indisponibilidad debe lanzar error. UnconfiguredProjectFiles devuelve 503. No se elige proveedor ni se simula recepción real.

Los binarios quedan fuera de MongoDB. Las respuestas públicas omiten referencia y hash del archivo. Los enlaces solo se validan como referencias HTTPS del host autorizado: no se descargan, siguen redirects ni certifican contenido, autoría o disponibilidad remota. Si el producto exige comprobar estas propiedades, necesita un verificador aprobado antes de habilitar esa modalidad.

### Consultas que Backend A exporta

- [ProjectSubmissionPort](src/modules/projects/application/project-ports.ts): `hasValidSubmission(usuarioId: string, cursoId: string): Promise<boolean>`, exportado por ProjectsModule. Comprueba una entrega registrada propia con estructura válida; no exige aprobación docente. Validez al registro no equivale a reinspección permanente de archivos/enlaces.
- [AssessmentResultsPort](src/modules/assessments/application/assessment-context.ts): `hasPassedFinalExam(usuarioId: string, cursoId: string): Promise<boolean>`, exportado por AssessmentsModule. Consulta un resultado aprobado de examen final del estudiante/curso, incluidas versiones históricas. No modifica progreso.

`false` significa ausencia de entrega/aprobación, no fallo de dependencia. Las fallas se propagan y terminan en 503 sanitizado cuando se atiende HTTP. Son consultas internas para consumidores confiables: el llamador debe usar identidad autorizada y validar pertenencia de recursos.

## Cableado NestJS y ejemplo de consumo

Los puertos son clases abstractas y sus tokens de inyección son esas clases. Para conectar adaptadores reales, sustituir el proveedor de AssessmentProgressPort en AssessmentsModule y el de ProjectCoursePort/ProjectFilePort en ProjectsModule, importando los módulos que exporten los servicios reales necesarios. Registrar otro proveedor solo en AppModule no reemplaza automáticamente los proveedores locales de esos módulos. No usar `overrideProvider` fuera de las pruebas.

No importar el módulo educativo completo en Assessments si aquel ya importa Assessments para consultar resultados: se formaría un ciclo. Separar adaptadores/servicios de lectura de Backend B de los consumidores de resultados o utilizar un módulo de composición acíclico. Acordar el cableado tras revisar sus módulos reales; no crear copias de sus modelos ni recurrir a `forwardRef` para ocultar un diseño circular.

Ejemplo de consumidor interno en un futuro archivo dentro de `src/integration/`; el módulo que lo declare debe importar AssessmentsModule y ProjectsModule:

```typescript
import { Injectable } from '@nestjs/common';
import { AuthenticatedUser } from '../modules/auth/access-control';
import { AssessmentResultsPort } from '../modules/assessments/application/assessment-context';
import { ProjectSubmissionPort } from '../modules/projects/application/project-ports';

@Injectable()
export class StudentCourseResults {
  constructor(
    private readonly assessments: AssessmentResultsPort,
    private readonly projects: ProjectSubmissionPort,
  ) {}

  async read(user: Readonly<AuthenticatedUser>, cursoId: string) {
    const [examenAprobado, proyectoEntregado] = await Promise.all([
      this.assessments.hasPassedFinalExam(user.id, cursoId),
      this.projects.hasValidSubmission(user.id, cursoId),
    ]);
    return { examenAprobado, proyectoEntregado };
  }
}
```

Este ejemplo no implementa progreso ni publica un endpoint. Un controlador privado debe reutilizar [CurrentUser y Roles](src/modules/auth/access-control.ts), exigir estudiante y validar el curso/propiedad; nunca tomar usuarioId del body. [AccessControlModule](src/modules/auth/access-control.module.ts) instala JwtAuthGuard y RolesGuard globales en la aplicación principal. Public omite ambos: no aplicarlo a rutas educativas privadas. JWT emitidos pueden seguir válidos hasta expirar tras logout/reset; no hay revocación inmediata nueva.

## Reglas y contratos HTTP

Solo evaluaciones publicadas; preguntas/opciones embebidas sin opcionCorrectaId en respuestas públicas. Corrección en servidor y aprobación desde 70%. Todas las preguntas deben contestarse; esta fue una decisión provisional del equipo que debe confirmarse posteriormente. Cuestionarios admiten nuevos intentos ilimitados.

El examen exige cinco módulos distintos completados y entrega válida, sin aprobación docente adicional. Máximo tres intentos por estudiante/curso, incluso entre versiones. Aprobar no impide usar los cupos restantes. La finalización global del curso corresponde a Backend B.

Las rutas usan `/api/v1`, Bearer JWT, rol estudiante, DTO estricto y no-store:

- GET `/evaluaciones?moduloId=...`: cuestionarios. GET `/evaluaciones?tipo=examen_final&cursoId=...`: finales elegibles; sin elegibilidad/cupos se excluyen del listado.
- GET `/evaluaciones/:evaluacionId` y POST `/evaluaciones/:evaluacionId/intentos`: finales exigen `?cursoId=...` coincidente. Body de envío: `version`, `solicitudId`, `respuestas: [{preguntaId, opcionId}]`.
- GET `/intentos-evaluacion`: historial propio, filtros opcionales cursoId/moduloId/evaluacionId y orden fecha_desc/fecha_asc/porcentaje_desc/porcentaje_asc. GET `/intentos-evaluacion/:intentoId`: resultado propio.
- GET `/cursos/:cursoId/proyecto`: instrucciones/política. POST `/cursos/:cursoId/entregas-proyecto`: `solicitudId`, `evidencias: [{tipo: "enlace", url}]` o `[{tipo: "archivo", referencia}]`; no multipart ni bytes.
- GET `/cursos/:cursoId/entregas-proyecto`: historial propio. GET `/entregas-proyecto/:entregaId`: entrega propia.

Paginación: pagina predeterminada 1, máximo 10000; limite predeterminado 20, máximo 50. Intentos y entregas devuelven items/pagina/limite/hayMas; listado de evaluaciones devuelve items/pagina/limite. Creación y replay idéntico devuelven 201. Nuevo solicitudId representa nuevo envío sujeto al límite correspondiente; mismo identificador con otro curso/evaluación/versión/contenido produce 409. El orden de evidencias/respuestas se canonicaliza.

Errores: 400 entrada/evidencia inválida o cursoId requerido ausente; 401 autenticación inválida; 403 rol no permitido, requisitos de examen incompletos o cupos agotados; 404 evaluación/curso no disponible o recurso ajeno/inexistente; 409 conflicto de versión/idempotencia; 503 dependencia, política, MongoDB o índice no preparado. `isQuizAvailable=false` produce 404/exclusión. Los adaptadores pueden denegar explícitamente acceso mediante excepciones HTTP apropiadas; no deben convertir una falla en permiso o datos negativos aparentes.

Historial y replay de un resultado propio ya confirmado no exigen recuperar elegibilidad actual ni consumen cupos: no vuelven a presentar preguntas o registrar otro resultado. No aceptar rol, nota, progreso o validez enviados por el cliente. CORS y confianza en proxies permanecen deshabilitados; coordinar frontend/HTTPS/Origin antes del despliegue, sin recomendar localStorage para tokens.

## Persistencia y operación

Se mantienen evaluaciones, intentos_evaluacion y entregas_proyecto, con referencias ObjectId a usuarios/cursos/módulos. El progreso se consulta mediante puerto: no hay relación directa ni escritura desde A hacia progreso_curso. Las versiones e históricos son append-only por los modelos; MongoDB no impone claves foráneas ni protege contra operadores privilegiados que eludan Mongoose.

autoCreate/autoIndex están deshabilitados. Preparar colecciones e índices solo con autorización, respaldo y revisión de datos/duplicados antes de habilitar escritores:

- intentos_evaluacion: usuarioId_1_solicitudId_1, único `{usuarioId:1, solicitudId:1}`, collation simple; también usuarioId_1_fecha_-1 para historial.
- entregas_proyecto: usuarioId_1_solicitudId_1, único `{usuarioId:1, solicitudId:1}`, collation simple.

Las escrituras inspeccionan los índices únicos en lectura y rechazan ausencia, hidden, sparse, partial o incompatibilidad. No usan syncIndexes ni instalan índices. El instalador de identidad no los administra. No eliminar documentos/índices incompatibles para resolver una instalación. Esta guía no certifica la base real ni ejecuta migraciones.

El límite concurrente usa transacciones snapshot/majority, conteo persistido y _id ObjectId derivado del estudiante/curso/cupo; no mutex en memoria. Todos los escritores deben respetar ese protocolo y conservar históricos. Borrados, restauraciones selectivas o cambios concurrentes de política requieren coordinación operativa. Las consultas a progreso, curso y almacenamiento no constituyen una transacción distribuida: definir consistencia al conectar los adaptadores. No agregar efectos secundarios a puertos de lectura; las transacciones pueden repetir consultas.

## Pasos para integrar y validar

1. Revisar las versiones reales de cursos/progreso de Backend B y su aprobación antes de acordar adaptadores. La referencia local inspeccionada origin/feat/learning-content apuntaba a 40c3c2b y solo contenía la base antigua de identidad; no demuestra el estado actual de GitHub. No se realizó fetch ni cambio de rama.
2. Confirmar datos ObjectId, pertenencia curso/módulo, identidad autorizada y fuente de política. Resolver los pendientes académicos: 30 preguntas, PDF/DOCX, 10 MB (decimal/MiB), tres enlaces, dos reentregas y publicación/versionado. Las fixtures no son aprobación.
3. Implementar adaptadores reales en los límites acordados, configurar proveedores acíclicos y mantener bloqueados los servicios ausentes. No conectar directamente modelos de A desde Backend B ni recrear cursos/progreso en A.
4. Preparar las colecciones/índices en un entorno autorizado. Para pruebas usar exclusivamente los helpers [MongoDB/Redis aislados](test/integration-isolation.ts), no la base de aplicación ni cuotas compartidas.
5. Reutilizar [evaluaciones](test/assessments.integration.spec.ts) y [entregas](test/projects.integration.spec.ts): cubren elegibilidad, publicación, 70%, límites, versiones, replay, concurrencia, privacidad, MongoDB fallido y puente A2 con entrega persistida. Añadir únicamente casos nuevos del adaptador real, incluido fallo de dependencia. Los archivos actuales se prueban mediante un registro confiable simulado, sin proveedor real.
6. Con cambios de código, ejecutar `npm.cmd run build`, `npm.cmd run lint` y una regresión final `node scripts/mailpit.cjs suite`. El [runner](scripts/mailpit.cjs) habilita integraciones y detectOpenHandles; requiere MongoDB replica set, Redis, Docker y OpenSSL según [README](README.md). MongoDB usa bases UUID propias, Redis namespace exclusivo/TTL y Mailpit proyecto temporal sin correo real. Comprobar cero omisiones, recursos abiertos y limpieza; no FLUSH ni borrados de datos compartidos.

La implementación de Backend A está preparada para revisión. La integración educativa real, almacenamiento y despliegue permanecen pendientes; esto no declara terminado Backend B, frontend ni producción.
