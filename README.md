# Lethics — Backend

Lethics es una plataforma web educativa orientada al aprendizaje de ética profesional, principios, legislación y buenas prácticas en el desarrollo de software.

Este repositorio contiene su API REST. Actualmente proporciona los servicios de identidad, seguridad y el núcleo de cuestionarios; sobre esta base se incorporarán los contenidos educativos, las demás actividades y el seguimiento del estudiante.

## Acerca del proyecto

La plataforma busca acercar estos conocimientos a estudiantes del área de software mediante un recorrido de aprendizaje estructurado, con materiales de consulta y actividades de aplicación. Su contenido tiene fines educativos y no sustituye asesoría legal.

El backend y el frontend se desarrollan en repositorios separados. La API está destinada a integrarse con una interfaz en Next.js.

## Funcionalidades principales

**Implementadas**

- Registro de estudiantes, verificación del correo y reenvío de códigos.
- Inicio de sesión, rotación de refresh tokens, detección de reutilización y cierre de sesión.
- Recuperación y restablecimiento de contraseña, con revocación de sesiones.
- Autenticación de rutas privadas, autorización por rol y consulta del perfil propio.
- Consulta segura de cuestionarios, calificación en el servidor e historial privado con envíos idempotentes.
- Envío SMTP, limitación de solicitudes con Redis y comprobaciones operativas.
- Endpoint de salud y documentación interactiva con Swagger.

**Previstas**

- Consulta y organización de cursos, módulos, lecciones y flashcards.
- Flujo completo del examen final, actividades y entregas de proyectos.
- Seguimiento del progreso y resultados del estudiante.

Estas funcionalidades educativas todavía no cuentan con módulos ni endpoints en la estructura actual del repositorio.

## Tecnologías utilizadas

- **Node.js 22, NestJS 11 y TypeScript:** aplicación y API REST.
- **MongoDB 8.0 y Mongoose:** persistencia documental y transacciones.
- **Redis 7.4:** control de frecuencia de solicitudes.
- **Argon2id y JWT HS256:** protección de contraseñas y autenticación.
- **Nodemailer y Mailpit:** transporte SMTP y captura de correo en pruebas locales.
- **Jest y Supertest:** pruebas unitarias y de integración HTTP.
- **Docker Compose y Swagger/OpenAPI:** entorno local y documentación de la API.

## Arquitectura

El backend se organiza en módulos de autenticación HTTP, identidad, usuarios, evaluaciones y salud. Los casos de uso se separan de los controladores y de la persistencia; seguridad y limitación de solicitudes son componentes compartidos.

MongoDB almacena usuarios, tokens de cuenta, sesiones, evaluaciones e intentos. Redis mantiene las cuotas de autenticación. El frontend consume la API REST y no accede directamente a estas bases de datos.

La estructura principal se encuentra en [src/modules](src/modules), [src/infrastructure](src/infrastructure) y [src/config](src/config). Los módulos educativos se incorporarán siguiendo esta organización.

## Requisitos previos

- Node.js **22.x** y npm.
- Docker con Docker Compose; Docker Desktop en Windows.
- Puertos locales disponibles: **3000** para la API, **27018** para MongoDB y **6380** para Redis.
- Para las pruebas SMTP con Mailpit: OpenSSL en `PATH` o indicado mediante `OPENSSL_BIN`.

Los servicios de datos se ejecutan en Docker y NestJS se ejecuta en el equipo anfitrión. El replica set local de un nodo permite transacciones, pero no proporciona alta disponibilidad.

## Instalación

Desde la raíz del repositorio, instala las dependencias:

```sh
npm ci
```

Crea tu configuración local a partir de [.env.example](.env.example), sin sobrescribir un archivo existente. En PowerShell:

```powershell
if (-not (Test-Path .env)) { Copy-Item .env.example .env }
```

Completa los valores indicados en la sección de configuración antes de continuar. Después inicia MongoDB con replica set y Redis:

```sh
docker compose -f compose.replica.yaml -f compose.redis.yaml up -d
docker compose -f compose.replica.yaml -f compose.redis.yaml ps -a
```

Espera a que los servicios estén saludables. El inicializador configura el replica set `lethics-rs`. Usa [compose.replica.yaml](compose.replica.yaml) para los flujos de identidad: la alternativa standalone de `compose.yaml` no admite sus transacciones.

Inicia el servidor de desarrollo:

```sh
npm run start:dev
```

Con el puerto predeterminado, la API responde en `http://localhost:3000/api/v1` y Swagger está en `http://localhost:3000/docs`. La conexión inicial a MongoDB es obligatoria.

Para ejecutar la versión compilada:

```sh
npm run build
npm start
```

En PowerShell, utiliza `npm.cmd` si la política de ejecución impide usar `npm.ps1`. Para detener los servicios sin eliminar sus datos:

```sh
docker compose -f compose.replica.yaml -f compose.redis.yaml down
```

Conserva los volúmenes de datos y la clave interna del replica set. Cambiar las credenciales de inicialización no cambia los usuarios de un volumen ya existente; no lo borres para resolver una diferencia de configuración.

## Configuración

[.env.example](.env.example) contiene las variables y valores de referencia. Sustituye sus marcadores por valores locales; `.env` está ignorado por Git.

- **MongoDB:** configura las credenciales y `MONGODB_URI`, incluyendo `authSource=admin` y `replicaSet=lethics-rs`.
- **Redis:** establece `REDIS_PASSWORD` y la misma credencial en `REDIS_URL`. Codifica los caracteres especiales al construir ambas URI.
- **Seguridad:** proporciona claves independientes de 32 bytes aleatorios en base64 para `JWT_ACCESS_SECRET_BASE64`, `VERIFICATION_CODE_HMAC_KEY_BASE64` y `RATE_LIMIT_HMAC_KEY_BASE64`.
- **JWT:** configura issuer, audience y duración. El acceso tiene un máximo de 15 minutos; la duración inicial del refresh es de siete días.
- **HTTP y correo:** `AUTH_HTTP_ENABLED=false` y `VERIFICATION_MAIL_TRANSPORT=disabled` bloquean por defecto las operaciones de autenticación pública. Registro, reenvío y solicitud de recuperación requieren SMTP configurado.
- **Navegador:** define `AUTH_BROWSER_ORIGIN` para el origen autorizado; refresh y logout lo requieren. Las cookies son HttpOnly y SameSite Strict; en producción, Secure es obligatorio.

Para generar una clave, ejecuta este comando por separado para cada variable y guarda el resultado únicamente en tu configuración privada:

```sh
node -e "console.log(require('node:crypto').randomBytes(32).toString('base64'))"
```

Antes de habilitar autenticación, prepara explícitamente las colecciones `usuarios`, `tokens_cuenta` y `sesiones` en la base autorizada. No se crean automáticamente. Con la aplicación compilada, estas comprobaciones son de lectura:

```sh
npm run ops:config
npm run ops:identity
npm run ops:redis
```

Los índices únicos de correo y hash de token tampoco se instalan al arrancar. `npm run ops:install-identity-indexes` permite instalarlos con comprobación previa de datos y confirmación interactiva. Úsalo solo sobre un destino autorizado, con respaldo y escritores detenidos; no corrige datos heredados ni elimina índices incompatibles. Redis debe superar las comprobaciones de persistencia y continuidad; tras un reinicio puede mantenerse bloqueado hasta una hora.

El núcleo de cuestionarios requiere además las colecciones `evaluaciones` e `intentos_evaluacion`, preparadas explícitamente. En intentos se declaran los índices `{ usuarioId: 1, solicitudId: 1 }` único y `{ usuarioId: 1, fecha: -1 }` para historial. No se instalan automáticamente ni los gestiona el instalador de índices de identidad. Sin el índice único compatible, el envío de respuestas permanece bloqueado.

Para consultar correo local sin destinatarios reales:

```sh
node scripts/mailpit.cjs serve
```

El comando imprime la URL de Mailpit y los valores SMTP de prueba que debes establecer en la sesión antes de iniciar Node.js, incluido `NODE_EXTRA_CA_CERTS`. La interfaz usa normalmente `http://127.0.0.1:8025`; si los puertos están ocupados, el script selecciona otros. Ctrl+C limpia su entorno temporal. El adaptador de desarrollo sin SMTP no envía correo ni simula una entrega satisfactoria.

## API REST

Las rutas implementadas utilizan el prefijo `/api/v1`:

- `GET /health`: estado de la API y conexión a MongoDB.
- `POST /auth/register`: registro con `nombre`, `correo` y `contraseña`; asigna el rol estudiante.
- `POST /auth/verify`: verificación con `correo` y `codigo`.
- `POST /auth/resend`: solicitud de otro código mediante `correo`.
- `POST /auth/login`: inicio de sesión con `correo` y `contraseña`.
- `POST /auth/refresh`: renovación mediante la cookie refresh y cuerpo JSON `{}`.
- `POST /auth/logout`: cierre de sesión mediante la cookie y cuerpo JSON `{}`.
- `GET /users/me`: perfil propio con `Authorization: Bearer <accessToken>`.
- `POST /auth/password/forgot`: solicitud de recuperación mediante `correo`.
- `POST /auth/password/reset`: restablecimiento con `token` y `nuevaContraseña`.
- `GET /evaluaciones?moduloId=<ObjectId>`: cuestionarios publicados disponibles, por versión y con paginación.
- `GET /evaluaciones/:evaluacionId`: cuestionario sin respuestas correctas.
- `POST /evaluaciones/:evaluacionId/intentos`: envío completo con `version`, `solicitudId` y `respuestas` (`preguntaId`, `opcionId`).
- `GET /intentos-evaluacion`: historial propio paginado, con filtros por evaluación/módulo y orden por fecha o porcentaje.
- `GET /intentos-evaluacion/:intentoId`: detalle de un intento propio.

Swagger en `/docs` permite explorar los contratos y muestra las operaciones de autenticación habilitadas por configuración. Una ruta implementada puede responder 503 si está deshabilitada o falta una protección obligatoria. Las respuestas de registro y recuperación no confirman la existencia de cuentas ni la entrega del correo.

El cliente debe conservar el access token en memoria y dejar que el navegador administre la cookie refresh; no guardar credenciales en localStorage. Las renovaciones deben coordinarse para evitar consumir simultáneamente el mismo refresh. Los JWT ya emitidos pueden seguir válidos hasta expirar después de logout o de un cambio de contraseña.

CORS y la confianza en proxies permanecen deshabilitados. Configurar Origin no habilita peticiones entre distintos orígenes; la conexión del frontend debe ajustarse a una política de despliegue aprobada. La autorización de recursos propios requiere comprobar su pertenencia, además del rol.

## Pruebas

Las comprobaciones de código y las pruebas que no necesitan servicios externos se ejecutan con:

```sh
npm run build
npm run lint
npm test -- --detectOpenHandles
```

Sin las variables de integración, Jest omite las suites que necesitan MongoDB, Redis o Mailpit. Esa ejecución no equivale a una validación completa.

Con Docker, MongoDB y Redis disponibles, y OpenSSL configurado, utiliza el runner aislado existente:

```sh
# SMTP y flujos HTTP asociados
node scripts/mailpit.cjs test

# Suite completa, incluidas las integraciones
node scripts/mailpit.cjs suite
```

El runner toma las conexiones locales de `.env` o de `LETHICS_IDENTITY_TEST_URI` y `LETHICS_REDIS_TEST_URL`. Si defines la URI semilla de pruebas MongoDB, apunta a `admin`, no a `lethics`; los helpers crean bases UUID propias en `localhost:27018`. Redis utiliza namespaces exclusivos en el puerto local 6380. Se requieren permisos para listar bases y para crear, inspeccionar y eliminar las bases temporales y sus índices.

Mailpit se crea en un proyecto Docker independiente y se elimina al terminar, junto con su red y certificados. Las pruebas no envían correo real ni limpian bases de aplicación o cuotas compartidas. Revisa siempre las omisiones y la limpieza informadas por la ejecución.

## Estado del proyecto

La base de identidad y seguridad y el núcleo de cuestionarios están implementados con pruebas unitarias y de integración. Los cuestionarios exigen responder todas las preguntas, se aprueban desde el 70% y permiten nuevos intentos independientes; `solicitudId` evita duplicar un mismo envío técnico.

La disponibilidad de cuestionarios depende de un contrato con cursos, módulos y progreso todavía no integrado: el proveedor predeterminado falla cerrado y las pruebas usan fixtures explícitos. Las rutas están implementadas, pero no se afirma disponibilidad educativa real sin ese adaptador y la preparación de datos e índices. Los contenidos, el flujo de examen final, las entregas y el progreso continúan en desarrollo.

La preparación para producción requiere definir el despliegue del frontend, SMTP, Origin/CORS, proxies, retención de sesiones y recuperación durable de los envíos de correo. Las pruebas locales no sustituyen estas decisiones. Los permisos administrativos todavía no están aprobados.

## Equipo y colaboración

Lethics se desarrolla de forma colaborativa, con responsabilidades distribuidas entre backend, frontend y funcionalidades educativas. El trabajo se organiza en ramas `feature` y se revisa mediante pull requests hacia `dev`.

Cada cambio debe mantener los contratos compartidos, incluir las comprobaciones pertinentes y respetar los módulos desarrollados por otras personas del equipo.
