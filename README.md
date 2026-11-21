# Lethics — Backend

## Incremento 7: confiabilidad de correo

El envío continúa después del commit de usuario/token. Antes de este incremento se realizaba una sola llamada SMTP: un fallo dejaba la cuenta sin verificar y el token vigente, sin recuperación automática. Ahora el [adaptador existente](src/modules/identity/infrastructure/smtp-verification-mailer.ts) aplica una [política conservadora](src/modules/identity/infrastructure/smtp-delivery-policy.ts) de **dos intentos como máximo** por invocación, con una sola espera de **500 ms**. No se reejecutan registro, transacciones ni generación de códigos; no se descuentan emisiones o solicitudes adicionales por reintentar SMTP.

| Fallo observado en Nodemailer 10.6.1 | Clasificación y actuación |
|---|---|
| `ESOCKET`, `originalCode=ECONNREFUSED`, `command=CONN` | Conexión rechazada antes del mensaje: admite un reintento. |
| `EDNS`, `originalCode=EAI_AGAIN`, `command=CONN` | Resolución temporal antes de conectar: admite un reintento. |
| `ETIMEDOUT`, `command=CONN`, `timeoutType=CONNECT_TIMEOUT` o `GREETING_TIMEOUT` | Fase anterior al mensaje demostrada: admite un reintento. |
| Respuesta SMTP 4xx con `EENVELOPE` en `MAIL FROM`/`RCPT TO`, o `EPROTOCOL`/`ECONNECTION` en `EHLO`/`HELO` | Rechazo temporal explícito anterior a DATA: admite un reintento. |
| Autenticación, incluso una respuesta temporal de AUTH; configuración, TLS/certificados; DNS permanente | No reintentar automáticamente; corregir la causa fuera de la solicitud. |
| Respuesta 5xx, incluido destinatario rechazado | Rechazo permanente: no reintentar. |
| Rechazo explícito durante DATA | Se conserva una política más restrictiva: no reintentar, incluso con 4xx. |
| Timeout de socket, reset, desconexión genérica `CONN`, respuesta incompleta o error desconocido | Resultado incierto: detener los reintentos. Puede haberse aceptado el mensaje. |

La clasificación usa metadatos del transporte, nunca búsquedas en el texto de un error ni la mera etiqueta «transitorio». `CONN` también aparece en fallos después de DATA y no acredita por sí solo que el mensaje no fue transmitido. Metadatos ausentes o distintos de los contemplados no habilitan reintentos. Al actualizar Nodemailer debe validarse de nuevo este contrato.

Se mantienen los timeouts existentes: DNS, conexión y saludo de 5 s cada uno; socket inactivo de 10 s. Solo se admite iniciar el reintento dentro de los primeros **15 s**, medidos con reloj monotónico, incluyendo su espera. Esta ventana no cancela una operación SMTP ya iniciada ni es un timeout total de la solicitud. Los timeouts son de fase/inactividad; un servidor que progresa lentamente puede prolongar el tiempo total. No se introducen cancelaciones que conviertan una entrega aceptada en un reintento. La comprobación HTTP previa `assertAvailable()` sigue siendo una sola operación sin envío: si falla, retorna 503 antes de escribir identidad. Al solicitar cierre del adaptador no se inicia otro intento.

Cada invocación construye una sola vez destinatario, código, fecha, cuerpo y un Message-ID UUID independiente de los secretos. Los conserva durante su eventual reintento; un reenvío explícito obtiene otro código y Message-ID. **Message-ID permite correlación, no deduplicación SMTP.** No se reintenta una aceptación ni un resultado incierto; no se ofrece garantía de exactamente una entrega. Un timeout tras el terminador DATA puede significar que el servidor aceptó el correo y se perdió el 250 final. Referencia: [RFC 5321, respuestas tras DATA y timeouts](https://www.rfc-editor.org/rfc/rfc5321.html#section-4.2.5).

La aceptación SMTP solo indica que el servidor aceptó responsabilidad; no confirma entrega al buzón, ausencia de filtrado, ni lectura. `VerificationDeliveryError` sigue siendo genérico, sin respuesta SMTP original, credenciales ni código. El controlador conserva 202 `Solicitud recibida.` después de un fallo postcommit: confirma recepción de la solicitud, no envío exitoso; el evento de log permanece fijo. El adaptador solo resuelve exitosamente si el destinatario figura aceptado y no hay rechazos. Una cuenta no se verifica por enviar correo: necesita consumir su código mediante el caso de uso existente.

Un fallo o corte de proceso no revierte identidad ni extiende la vigencia de cinco minutos. El token permanece vigente hasta expiración, consumo o revocación; puede haber sido recibido aunque el transporte haya fallado. Reenvío explícito sigue exigiendo 60 s y cuotas persistentes, revoca los códigos anteriores y no restablece los fallos acumulados. No se recrea estado ni se reenvía automáticamente al reiniciar el backend.

### Recuperación durable: propuesta pendiente de aprobación

La memoria del proceso contiene el código; MongoDB solo conserva su HMAC, que no permite reconstruirlo. Si Nest se detiene después del commit y antes del envío, se pierde la posibilidad de enviar ese mismo código automáticamente. Un corte después de la aceptación SMTP pero antes de registrar su resultado deja además una ventana de incertidumbre. La implementación actual ofrece reintentos dentro del proceso, **no entrega durable**.

Si se requiere recuperar emisiones después de reinicios, se recomienda una outbox transaccional y un worker, en un incremento aprobado por separado. Propuesta de nueva colección `entregas_verificacion` (no creada): identificador de entrega, referencia a usuario/token y propósito, Message-ID estable, payload cifrado autenticado con clave independiente y versión de clave, expiración ligada al token, estado, intentos, próxima ejecución y lease con fencing para exclusión entre workers. Insertar el trabajo en la misma transacción que usuario/token; índices de unicidad por emisión/token y de planificación/lease, más política aprobada de retención. No almacenar contraseña ni código en claro, ni usar `tokens_cuenta` como cola.

El worker comprobaría cuenta sin verificar y token vigente/no revocado/no usado antes de intentar enviar; una revocación concurrente aún podría producir un correo tardío, pero su código no sería válido. Trabajos vencidos o cancelados no deben renovar códigos ni cuotas. La outbox permite recuperar trabajos pendientes confirmados, pero no elimina la incertidumbre entre SMTP y MongoDB: un lease vencido tras un intento puede corresponder a una entrega aceptada. Ese estado necesita conciliación y una política explícita; Message-ID no hace segura su repetición automática. Requiere aprobar el modelo, cifrado/rotación, retención, operación del worker y tratamiento de duplicados antes de implementar. No se añadió colección, cola ni campo de entrega.

### Pruebas y alcance del cierre

`node scripts/mailpit.cjs test` ejecuta las pruebas específicas del adaptador, política, HTTP con MongoDB/Redis aislados y Mailpit. Incluye un receptor SMTP TLS de fallos exclusivamente local: rechazo 451 anterior a DATA seguido de aceptación, rechazo permanente 550 y recepción completa de DATA seguida de desconexión o de falta del 250 hasta agotar el timeout real del cliente. Estos receptores no realizan entregas externas. Las pruebas comprueban límites de intentos, Message-ID/código estables, ventana de reintento y cierre durante espera, consistencia usuario/token/cuotas, recuperación por reenvío y ausencia de secretos en logs/respuestas. Se mantienen las pruebas de aceptación real en Mailpit y credenciales incorrectas. Solo se usan direcciones `example.test` en estos escenarios.

La regresión completa se ejecuta una vez al finalizar con `node scripts/mailpit.cjs suite` (invoca `npm test -- --detectOpenHandles`). Los helpers existentes conservan bases MongoDB UUID propias y namespaces Redis exclusivos con TTL. No se habilitan rutas públicas ni se modifican volúmenes o datos reales.

Validación final del incremento 7 (2026-11-21): build y lint aprobados. Pruebas específicas: 51 aprobadas en 4 suites, 0 fallidas/omitidas (39,992 s). Única ejecución completa final: **183 pruebas aprobadas en 21 suites, 0 fallidas y 0 omitidas** (109,972 s), con `--detectOpenHandles` y sin advertencias de recursos abiertos. Limpieza comprobada: 0 bases MongoDB temporales, 0 contenedores Mailpit y 0 directorios de certificados; Compose confirmó eliminación de su red. Redis conserva solo claves aisladas con expiración por TTL. `git diff --check` pasó con advertencias LF/CRLF. No se modificaron configuración privada, datos reales, volúmenes ni activación pública; no se realizaron escrituras de Git.

El cierre técnico del incremento se determina por build, lint y pruebas. El cierre operativo de Fase 3B requiere decidir y aceptar explícitamente la limitación de entrega no durable, o aprobar su resolución posterior, además de las precondiciones de despliegue ya documentadas. Para producción se mantienen transporte/remitente autorizados, SPF/DKIM/DMARC según el despliegue, custodia de claves/TLS, monitoreo de aceptación/rechazos y tratamiento de rebotes. No se declara recuperación tras reinicios ni entrega a buzón a partir de esta prueba local.

## Incremento 6: correo de extremo a extremo con Mailpit

Se reutilizan el controlador, los casos de uso, el adaptador SMTP y la fábrica del incremento 5. No se cambia la activación pública de HTTP ni la configuración privada. Mailpit captura mensajes localmente; no se configura relay, forwarding ni entrega a Internet. Las pruebas usan exclusivamente destinatarios `example.test`.

Requisitos adicionales: OpenSSL accesible mediante `PATH` o `OPENSSL_BIN`, Docker Desktop disponible y las conexiones locales de MongoDB/Redis existentes. En Windows también se detecta `C:/msys64/ucrt64/bin/openssl.exe`. No se requiere instalar dependencias npm adicionales.

```powershell
# Mantener abierta esta sesión; Ctrl+C elimina únicamente este entorno Mailpit.
node scripts/mailpit.cjs serve
```

El script comprueba los puertos 1025 (SMTP) y 8025 (web/API) antes del arranque. Si están ocupados, informa los puertos alternativos elegidos. La interfaz se abre por defecto en `http://127.0.0.1:8025`; la API está en `/api/v1/messages`. Usa siempre la URL que imprime el script. Cada ejecución utiliza un proyecto Compose `lethics-mailpit-<UUID>` independiente con [compose.mailpit.yaml](compose.mailpit.yaml), imagen oficial `axllent/mailpit:v1.27`, puertos publicados exclusivamente en loopback y sin volúmenes persistentes. La base de captura reside en tmpfs; solo los certificados temporales se montan en lectura. MongoDB y Redis no forman parte de este Compose.

El adaptador existente exige autenticación y TLS validado. Mailpit se configura con STARTTLS obligatorio y credenciales ficticias `mailpit` / `mailpit-local-only`. El script genera un certificado de dos días con SAN para `localhost`/`127.0.0.1`. Para una aplicación local autorizada, establece en su sesión los valores impresos por `serve`: `VERIFICATION_MAIL_TRANSPORT=smtp`, `SMTP_HOST=localhost`, `SMTP_PORT=<puerto elegido>`, `SMTP_SECURE=false`, `SMTP_USER=mailpit`, `SMTP_PASSWORD=mailpit-local-only`, `SMTP_FROM=verificacion@example.test` y `NODE_EXTRA_CA_CERTS=<certificado impreso>`. Node debe iniciarse después de definir esta última variable. `SMTP_SECURE=false` exige STARTTLS; no permite SMTP sin cifrar. No uses `NODE_TLS_REJECT_UNAUTHORIZED=0`. Estos comandos no habilitan los endpoints de la aplicación habitual.

### Ejecución y aislamiento de las pruebas

```powershell
# Adaptador SMTP y flujo HTTP real contra un Mailpit nuevo y efímero:
node scripts/mailpit.cjs test

# Build y lint; después, una sola ejecución de npm test con todas las integraciones:
npm run build
npm run lint
node scripts/mailpit.cjs suite
```

Los modos `test` y `suite` crean Mailpit, esperan su API, ejecutan Jest con `--detectOpenHandles` y eliminan su contenedor, red y certificados al terminar, también ante fallos normales de prueba. Si se fuerza la terminación del proceso o Docker deja de responder, usa el nombre UUID impreso para revisar y retirar exclusivamente ese proyecto; nunca ejecutes limpieza global de Docker ni borres volúmenes.

Se reutilizan `LETHICS_IDENTITY_TEST_URI` y `LETHICS_REDIS_TEST_URL` cuando están definidas. Si faltan, el script lee únicamente las conexiones locales de la configuración privada, sin mostrar valores ni sobrescribir archivos, y deriva una URI semilla MongoDB con base `admin`. El helper existente genera una base UUID antes de conectarse, rechaza la base `lethics` y limita la limpieza a sus objetos exactos de base y cliente. Redis usa un namespace UUID exclusivo; las claves de cuota expiran por TTL, sin `FLUSHDB`, `FLUSHALL` ni borrado de cuotas ajenas. Los índices y documentos sintéticos se preparan solo dentro de la base temporal. El script no imprime secretos de MongoDB/Redis.

La nueva [prueba Mailpit](test/mailpit.integration.spec.ts) opta explícitamente por la fábrica SMTP real hacia loopback; el resto conserva el adaptador simulado de `NODE_ENV=test`. Sin las variables Mailpit suministradas por el script, esta prueba se omite deliberadamente. Para validar el incremento completo sin omisiones utiliza `suite`, no un `npm test` sin entorno de integración.

La prueba registra un estudiante por HTTP, comprueba el destinatario, asunto y texto recibido mediante la API, extrae el código sin imprimirlo y prueba reenvío inmediato bloqueado, emisión posterior y revocación del código anterior. Solo adelanta la antigüedad de la emisión en su documento sintético, sin reiniciar cuotas. Verifica la cuenta en MongoDB y rechaza reutilización. Comprueba ausencia de contraseña, código, hash y claves en logs/respuestas, y rechazo real de autenticación SMTP incorrecta sin entregar mensajes. Los escenarios HTTP de fallo cerrado y fallo posterior al commit siguen cubiertos por las pruebas existentes. Una respuesta genérica 202 solo confirma recepción de la solicitud; no declara entrega. Una cuenta sin verificar conserva `verificadoEn=null`; este incremento no añade rutas de contenido protegido ni credenciales de acceso.

El adaptador de desarrollo deshabilitado rechaza el envío; no simula éxito ni habilita registro/reenvío públicos. El adaptador de pruebas mantiene mensajes en memoria. SMTP realiza una conexión y entrega al servidor configurado: con Mailpit, el mensaje queda capturado localmente y no llega a un buzón externo.

Validación del incremento 6 (2026-11-21): build y lint aprobados; pruebas específicas SMTP/Mailpit: 12 aprobadas en 2 suites (14,822 s). Una sola ejecución final de `npm test -- --detectOpenHandles`: 148 aprobadas en 20 suites, 0 fallidas y 0 omitidas (95,224 s), sin advertencias de recursos abiertos. Se comprobó que quedaron 0 bases MongoDB temporales, 0 contenedores Mailpit y 0 directorios de certificados temporales. Las claves Redis de pruebas conservan su expiración automática por TTL. No se modificaron datos reales, volúmenes MongoDB/Redis, configuración privada ni la activación pública de HTTP. `git diff --check` pasó con advertencias de conversión LF/CRLF.

Para producción siguen pendientes el transporte autorizado, identidad de remitente, DNS/SPF/DKIM/DMARC según el despliegue, custodia de secretos y certificados, y la decisión sobre recuperación de entregas después del commit sin cola durable. La aceptación SMTP en Mailpit no demuestra entrega a destinatarios externos ni elimina esos requisitos. Referencias: [imagen oficial](https://mailpit.axllent.org/docs/install/docker/), [STARTTLS y autenticación](https://mailpit.axllent.org/docs/configuration/smtp-authentication/), [API](https://mailpit.axllent.org/docs/api-v1/).

Base del backend REST de Lethics. El alcance y el modelo aprobado están en [el contexto](docs/LETHICS_BACKEND_CONTEXTO.md); las decisiones están en [arquitectura](docs/arquitectura.md). Incluye infraestructura de seguridad y contratos HTTP de registro/verificación con activación controlada; no implementa inicio de sesión. Las secciones de incrementos anteriores conservan su contexto histórico; el estado HTTP actual está en [Incremento 5](#incremento-5-endpoints-http-de-identidad).

## Requisitos

Node.js 22 LTS, npm y Docker con Compose. Desde la raíz, copia `.env.example` a `.env` y reemplaza los valores de usuario y contraseña por credenciales locales propias. Ajusta `MONGO_PORT` y el puerto correspondiente en `MONGODB_URI`; codifica para URI los caracteres especiales del usuario y contraseña. No compartas `.env`.

La aplicación también requiere `JWT_ACCESS_SECRET_BASE64`, `JWT_ACCESS_ISSUER`, `JWT_ACCESS_AUDIENCE` y `JWT_ACCESS_TTL_SECONDS`. Genera una clave distinta de 32 bytes criptográficamente aleatorios por entorno; no uses la clave de otro proyecto. Por ejemplo, en PowerShell puedes asignarla a la sesión sin imprimirla:

```powershell
$bytesClave = [byte[]]::new(32)
[System.Security.Cryptography.RandomNumberGenerator]::Fill($bytesClave)
$env:JWT_ACCESS_SECRET_BASE64 = [Convert]::ToBase64String($bytesClave)
```

Configura emisor, audiencia y duración en `.env`; el valor de 900 segundos del ejemplo es provisional. La clave debe suministrarse mediante un gestor de secretos o una variable local protegida, nunca compartirse o registrarse. La validación comprueba longitud, codificación y diversidad básica, pero no puede demostrar la entropía de la fuente. La configuración es obligatoria al iniciar aun cuando todavía no existan endpoints de autenticación.

```sh
docker compose up -d
docker compose ps
npm ci
npm run start:dev
```

MongoDB escucha solamente en `127.0.0.1`. El volumen nombrado conserva los datos entre reinicios. Las credenciales de inicialización solo se aplican a un volumen nuevo: cambiarlas en `.env` no modifica un usuario existente. La API inicia solo cuando puede conectarse a MongoDB. `GET http://localhost:3000/api/v1/health` responde con `api` y `mongodb`; devuelve 503 si se pierde la conexión después del arranque. Swagger está en `http://localhost:3000/docs`.

Para comprobar la salud del contenedor usa `docker compose ps`. Para detenerlo sin borrar datos usa `docker compose down`. **No uses `docker compose down -v` salvo que quieras eliminar permanentemente el volumen y sus datos.** El respaldo y la restauración requieren herramientas compatibles `mongodump`/`mongorestore`, credenciales y una ubicación segura externa al repositorio; valida el procedimiento y restaura en un entorno aislado antes de confiar en un respaldo. Esta configuración standalone no admite transacciones multipdocumento.

Un procedimiento local posible, con el servicio en ejecución, consiste en generar un archivo dentro del contenedor y copiarlo a una ubicación segura (sustituye las rutas y el ID por los de tu entorno):

```sh
docker compose exec mongodb sh -c 'mongodump --username "$MONGO_INITDB_ROOT_USERNAME" --password "$MONGO_INITDB_ROOT_PASSWORD" --authenticationDatabase admin --archive=/tmp/lethics.archive'
docker compose ps -q mongodb
docker cp <id-contenedor>:/tmp/lethics.archive <ruta-segura>/lethics.archive
```

Para restaurar, copia el archivo a `/tmp/lethics.archive` en un contenedor de prueba y ejecuta `docker compose exec mongodb sh -c 'mongorestore --username "$MONGO_INITDB_ROOT_USERNAME" --password "$MONGO_INITDB_ROOT_PASSWORD" --authenticationDatabase admin --archive=/tmp/lethics.archive'`. La restauración puede modificar datos existentes: comprueba primero su destino. Protege y elimina las copias temporales conforme a tu política de datos.

```sh
npm run build
npm run lint
npm test
npm start
```

## Replica set aislado para desarrollo en Windows

El `compose.yaml` anterior conserva el MongoDB standalone y su volumen original. El archivo `compose.replica.yaml` es una alternativa independiente: usa MongoDB 8.0, el replica set `lethics-rs`, el puerto local fijo 27018 y volúmenes nuevos `mongodb_rs_data` y `mongodb_rs_key`, separados por nombre de proyecto Compose. La clave interna se genera una sola vez en el volumen de clave mediante OpenSSL y no se guarda en el repositorio. Conserva **ambos** volúmenes. El nodo se anuncia como `localhost:27018`, accesible desde Windows y desde el inicializador que comparte su red. Esta configuración está diseñada para Nest en el host; no ofrece resolución para un Nest en otro contenedor.

En PowerShell, con Docker Desktop iniciado y desde esta carpeta:

```powershell
if (-not (Test-Path .env)) { Copy-Item .env.example .env }
# Edita .env: cambia usuario y contraseña por valores locales propios.
# Cambia MONGODB_URI al ejemplo del replica set y codifica caracteres especiales de las credenciales para URI.
docker compose -f compose.replica.yaml config --quiet
docker compose -f compose.replica.yaml up -d
docker compose -f compose.replica.yaml ps -a
docker compose -f compose.replica.yaml logs mongodb-rs-init
npm ci
npm run start:dev
```

El inicializador espera autenticación y crea el replica set solo si aún no existe. El healthcheck del contenedor exige un ping autenticado y que el nodo sea PRIMARY. Espera hasta ver `healthy`; `Invoke-RestMethod http://localhost:3000/api/v1/health` debe devolver `api: up` y `mongodb: up`. La API necesita una conexión inicial; si MongoDB cae después, health devuelve 503 con `api: up`, `mongodb: down` y el mensaje público `MongoDB no disponible`. Otros errores 5xx conservan un mensaje genérico. Swagger está en `/docs`.

La URI de ejemplo usa valores ficticios. Cambiar las variables de credenciales después de inicializar el volumen no cambia el usuario ya creado. Conserva la clave y los datos juntos; no reemplaces, reinicialices ni migres el volumen anterior. Para detener los servicios sin borrar datos: `docker compose -f compose.replica.yaml down`. Nunca uses `down -v` para detenerlos. El respaldo y la restauración siguen el procedimiento anterior, adaptando los comandos al archivo Compose y al servicio `mongodb-rs`; ensaya la restauración en un entorno aislado. El archivo temporal del respaldo contiene datos sensibles.

La prueba manual histórica en dos ejecuciones está deshabilitada: no acredita propiedad de la base dentro de la misma ejecución que realiza la limpieza. El script termina antes de conectarse y explica la omisión. Usa las suites Jest aisladas para probar transacciones. No se ensaya persistencia tras reiniciar contenedores en este incremento. Un replica set de un nodo no proporciona alta disponibilidad ni sustituye un despliegue de producción.

## Pruebas de persistencia de identidad

`npm test` ejecuta las pruebas unitarias sin MongoDB y omite la integración si no está configurada. Para ejecutar la integración, inicia el replica set local de prueba y ejecuta en PowerShell:

```powershell
$env:LETHICS_IDENTITY_TEST_URI = 'mongodb://USUARIO:CLAVE@localhost:27018/admin?authSource=admin&replicaSet=lethics-rs'
npm test -- --runTestsByPath test/identity.integration.spec.ts
Remove-Item Env:LETHICS_IDENTITY_TEST_URI
```

Sustituye las credenciales por las locales, codificadas para URI. La prueba acepta únicamente el servidor local en el puerto 27018, genera una base con UUID, verifica que no exista y la elimina al terminar solo si comprobó su propiedad y formato. Requiere permiso para listar bases, crear índices y eliminar esa base temporal. Los hashes usados son valores ficticios. Los índices de aplicación se declaran pero no se crean automáticamente al arrancar; su instalación controlada se describe en el incremento 4.

Para ejecutar toda la suite con integración, primero ejecuta `npm run build`, configura `LETHICS_IDENTITY_TEST_URI` como arriba y después `npm test`. Además de la prueba de identidad, se arranca el backend compilado con una clave JWT aleatoria temporal en un proceso aislado; se comprueban health, Swagger y fallos de configuración sin leer ni sobrescribir el `.env` del proyecto. Sin esa variable se omiten los casos que requieren MongoDB. Los procesos normales de desarrollo sí leen `.env`, y las variables del entorno del proceso tienen prioridad.

Los esquemas exigen los datos mínimos de identidad y verifican la sintaxis del correo, pero no comprueban su propiedad ni la existencia de usuarios referenciados. La política de nulabilidad de los demás campos y la forma de perfil siguen pendientes. El procedimiento propuesto de instalación de índices y las limitaciones de serialización están en `docs/arquitectura.md`.

## Registro y verificación: trabajo en preparación

El registro público debe asignar `estudiante` en el servidor. Se acordó un código de verificación de seis cifras con vigencia de cinco minutos. Hay componentes HMAC, DTO y casos de uso internos transaccionales, pero **no hay rutas de registro, verificación ni reenvío habilitadas**. Faltan la integración HTTP segura de controles, la política de proxies, la instalación controlada de índices y la entrega fiable. Los DTO aún no forman un contrato HTTP publicado y no aparecen en Swagger. No hay proveedor de correo real; el buzón en memoria solo se registra en entorno de pruebas.

Para `VERIFICATION_CODE_HMAC_KEY_BASE64`, genera de forma independiente 32 bytes aleatorios con el procedimiento indicado para JWT y consérvalos mediante una variable de entorno protegida; nunca reutilices la clave JWT ni la imprimas. Los controles por origen, el adaptador SMTP y la entrega fiable todavía requieren diseño y validación antes de publicar las rutas.

### Incremento 1: límites internos

Los casos de uso internos admiten cinco fallos por código, reenvío desde los 60 segundos y ventanas fijas de una hora por cuenta. Los valores provisionales `VERIFICATION_ACCOUNT_FAILURES_PER_HOUR` (20) y `VERIFICATION_ACCOUNT_EMISSIONS_PER_HOUR` (5, incluido registro) se validan en configuración. `VERIFICATION_CODE_HMAC_KEY_BASE64`, `RATE_LIMIT_HMAC_KEY_BASE64` y `JWT_ACCESS_SECRET_BASE64` deben ser tres claves distintas de 32 bytes aleatorios codificados en base64. También se exige `REDIS_URL` con contraseña. El inicio falla si faltan o son inválidos. No reemplaces `.env` existente.

En PowerShell puedes configurar temporalmente las dos claves HMAC sin mostrarlas ni editar archivos:

```powershell
$claveVerificacion = [byte[]]::new(32)
[System.Security.Cryptography.RandomNumberGenerator]::Fill($claveVerificacion)
$env:VERIFICATION_CODE_HMAC_KEY_BASE64 = [Convert]::ToBase64String($claveVerificacion)
$claveLimite = [byte[]]::new(32)
[System.Security.Cryptography.RandomNumberGenerator]::Fill($claveLimite)
$env:RATE_LIMIT_HMAC_KEY_BASE64 = [Convert]::ToBase64String($claveLimite)
```

Estas variables duran solo en la sesión; para persistirlas utiliza un gestor de secretos o configura manualmente el `.env` privado. Mantén estables las claves entre reinicios: cambiarlas invalida códigos pendientes o reinicia la identidad de contadores de origen; aplica la cuarentena documentada. No copies las claves a archivos versionados ni a registros.

El formato HMAC v2 incluye usuario y token. Los códigos anteriores y cuentas sin el estado de seguridad no se aceptan ni reenvían automáticamente: precisan un procedimiento de migración controlado. Rotar la clave invalida los códigos pendientes. El envío de correo de prueba ocurre después del commit y no tiene recuperación durable; no habilites rutas públicas hasta resolver los límites por origen y la entrega. El reloj del proceso determina los límites de tiempo, por lo que las instancias deben mantenerlo sincronizado.

### Redis aislado para límites por origen

`compose.redis.yaml` ejecuta Redis 7.4 con contraseña, puerto local configurable (6380), AOF `appendfsync always`, `noeviction`, límite de memoria y volumen independiente; no modifica Compose ni volúmenes MongoDB. En `.env`, configura `REDIS_PASSWORD` y `REDIS_URL` con la misma clave local, `RATE_LIMIT_HMAC_KEY_BASE64` con 32 bytes aleatorios independientes de JWT y de verificación, y un `RATE_LIMIT_NAMESPACE` propio por entorno. Genera las claves con el procedimiento de PowerShell descrito arriba y no las imprimas. Los valores de `.env.example` son marcadores y no deben usarse como credenciales reales. Para producción se requiere `rediss://`, contraseña y un namespace diferente de `development`.

```powershell
docker compose -f compose.redis.yaml config --quiet
docker compose -f compose.redis.yaml up -d
docker compose -f compose.redis.yaml ps
docker compose -f compose.redis.yaml down
```

`down` conserva el volumen; no uses `down -v`. Las cuotas iniciales son 60 verificaciones en 600 segundos, 20 registros en 3600 segundos y 20 reenvíos en 3600 segundos, configurables mediante las variables `RATE_LIMIT_*`. Cada ventana comienza con la primera solicitud para una combinación de operación y origen; la primera que supera la cuota se rechaza y la clave caduca al terminar la ventana. Las claves contienen HMAC de IP, no direcciones en claro.

La conexión es perezosa: si Redis o la configuración falla, el servicio lanza `RateLimitUnavailableError`, sin usar memoria local. Verifica AOF, fsync, ausencia de expulsión y rol primario, y tras cada reinicio Redis bloquea durante la ventana configurada más larga, aunque haya recuperado el AOF. `appendfsync always` reduce pérdida de escrituras, pero no garantiza durabilidad ante daños del almacenamiento o acciones administrativas. Solo se admite una instancia Redis dedicada sin failover o sustitución transparente; ante restauración, reemplazo, cambio de claves, namespace o cuotas, bloquea las operaciones al menos durante la mayor ventana antigua/nueva antes de volver a habilitarlas.

El servicio acepta exclusivamente la dirección del socket y un indicador explícito de proxy proporcionado por configuración confiable del servidor, nunca por el cliente. El modo detrás de proxy falla cerrado: no se procesan `X-Forwarded-For` ni se admiten proxies confiables todavía. Antes de habilitar endpoints se requiere implementar y probar la política de proxies, el uso obligatorio del limitador y el mapeo seguro a HTTP, además de entrega de correo e índices.

`IdentityModule` registra los casos internos y exporta `IdentityOperationsService`, que verifica Redis antes de invocar cada uno. Es una frontera interna, no un controlador: futuras rutas deben usarla y no acceder directamente a los servicios. En `development` el correo simulado descarta mensajes sin registrarlos; en `test` el buzón en memoria se puede inspeccionar solo desde pruebas. No se realiza entrega externa. En `production` el inicio falla hasta que exista un proveedor aprobado. La cuarentena Redis puede bloquear las operaciones una hora incluso tras un reinicio limpio; no se ha reducido, pues aún no existe una prueba de continuidad lo suficientemente fuerte.

Para ejecutar la integración aislada de Redis, configura `LETHICS_REDIS_TEST_URL` para Redis local en el puerto 6380 y ejecuta `npm test`; usa un entorno autorizado de prueba. La prueba crea exclusivamente claves con namespace y HMAC aleatorios y vencimiento, sin borrar ni cambiar cuotas existentes ni configuración del servidor. Sin la variable la integración Redis se omite.

## Fase 3B — Incremento 4: operación previa a HTTP

**Implementado:** herramientas de inspección y ensayo; no hay rutas públicas register, verify o resend. No se ha ejecutado instalación ni migración sobre datos reales. `autoCreate` y `autoIndex` siguen deshabilitados en los esquemas de identidad. La configuración válida no constituye autorización para publicar HTTP.

### Comprobaciones de solo lectura

Después de `npm run build`, desde la raíz:

```powershell
npm run ops:config
npm run ops:identity
npm run ops:redis
```

Las herramientas cargan el `.env` privado sin editarlo; las variables del proceso tienen prioridad. No imprimen secretos, URI, correos, hashes ni documentos. Los fallos inesperados se sanitizan. `ops:config` informa validez y nombres de campos inválidos, nunca sus valores. `ops:identity` devuelve opciones de índices y cantidades de datos incompatibles y devuelve código 1 si hay bloqueos; errores de lectura/permisos también bloquean. Usa el destino indicado por `MONGODB_URI`. No crea colecciones, índices ni marcadores, ni ejecuta `syncIndexes`. `ops:redis` solo usa INFO y CONFIG GET; diferencia estado incierto, cuarentena y disponibilidad operativa, sin incrementar contadores.

Diagnóstico observado el 2026-11-21: configuración local válida; Redis cumple las comprobaciones y terminó su cuarentena; en `lethics` faltan las colecciones `usuarios` y `tokens_cuenta`, por tanto sus índices. No se corrigió la base. Un conteo vacío sobre colecciones ausentes no prueba compatibilidad de un conjunto de datos heredado existente.

### Índices obligatorios e instalación autorizada

| Colección | Clave | Nombre requerido | Opciones |
|---|---|---|---|
| usuarios | `{correo: 1}` | `correo_1` | unique, collation simple, sin sparse/partial/TTL |
| tokens_cuenta | `{tokenHash: 1}` | `tokenHash_1` | unique, collation simple, sin sparse/partial/TTL |

Se acepta la definición histórica sin collation explícita cuando `listIndexes` indica semántica simple. Una collation heredada no simple se rechaza. Un nombre distinto requiere revisión operativa explícita; no se renombra automáticamente. Un índice con hidden: true se informa como incompatible y bloquea el registro; la herramienta no lo modifica. `_id_` lo administra MongoDB. Verificación localiza el token por `_id`; reenvío y revocación consultan por usuario. Un índice adicional por usuario/tipo podría mejorar rendimiento, pero requiere mediciones y no es requisito de unicidad de este incremento. No se agrega TTL, índice de sesiones ni índices educativos.

El registro comprueba ambas definiciones antes de calcular contraseña, abrir transacción o enviar correo. Si falta un índice, es incompatible o la lectura falla, no registra. Es una defensa de aplicación; la cuenta de servicio debe carecer de permisos de DDL y el equipo debe impedir cambios administrativos concurrentes de índices.

Para una instalación futura, autorizada y con ambas colecciones aprobadas **ya existentes**:

1. Confirmar servidor/base por un canal protegido, permisos mínimos, autorización, respaldo y restauración ensayada. Detener todos los escritores durante inventario e instalación; mantener HTTP deshabilitado.
2. Ejecutar `ops:identity`. Revisa índices existentes, campos ausentes/nulos/vacíos, sintaxis del correo, normalización trim/minúsculas y duplicados tras esa normalización. El análisis no devuelve valores. Usa memoria proporcional a los valores distintos; para grandes volúmenes ejecutar en una copia dimensionada y planificar una auditoría externa equivalente.
3. Resolver datos inválidos/duplicados y colecciones ausentes mediante un cambio separado autorizado. Esta herramienta no crea colecciones ni modifica datos.
4. Ejecutar `npm run ops:install-identity-indexes` desde una terminal interactiva. Revisa el informe y confirma escribiendo literalmente `INSTALL INDEXES <base>`. No admite confirmación por pipe ni una opción de aceptación automática. La confirmación declara autorización, escritores detenidos y respaldo comprobado.
5. El instalador repite precondiciones, crea únicamente los dos índices y verifica el resultado. No elimina índices. Los dos comandos DDL no son una transacción: si falla el segundo puede quedar instalado el primero. Conservar bloqueo, inspeccionar y repetir únicamente después de resolver la causa. MongoDB rechaza duplicados concurrentes; las precondiciones requieren ventana de mantenimiento para evitar carreras de datos/configuración.
6. Repetir `ops:identity` y registrar resultado sin datos personales. No habilitar HTTP solo por completar este paso.

Nunca ejecutar el instalador sobre desarrollo sin autorización adicional. Su instalación se ensaya exclusivamente en bases temporales; los índices incompatibles no se eliminan ni siquiera para reparar automáticamente un ensayo.

### Usuarios y tokens heredados: migración conservadora

Los usuarios nuevos tienen `seguridadVerificacion` con `tokenActualId`, `ultimaEmision`, `emisionesInicio`, `emisiones`, `fallosInicio`, `fallos` y `revision`. Los tokens nuevos tienen `versionHmac: 2` e `intentosFallidos`. El estado válido requiere ObjectId, fechas válidas y contadores enteros no negativos. Los servicios rechazan estado parcial/inválido, además del estado ausente. El token requiere versión 2 y contador entero entre cero y cinco; cinco sigue bloqueando su consumo. No se completan campos silenciosamente.

La función de ensayo `quarantineLegacyVerification` se limita por código a bases `lethics_ops_test_<UUID de 32 hex>` y confirmación exacta. En transacción revoca tokens de verificación activos con campos de seguridad incompatibles o usuario sin estado válido (incluye huérfanos). No toca recuperación, tokens ya usados/revocados, roles, `verificadoEn`, contadores de cuenta ni contadores de tokens. No genera códigos, no envía correo, no crea documentos ni colecciones. Repetir no cambia nuevamente los documentos. El inventario de solo lectura funciona también sobre el destino real.

Este ensayo es una migración de **cuarentena**, no de activación. Las cuentas no verificadas sin estado válido continúan bloqueadas; una cuenta con verificadoEn de tipo Date válido no se cuenta como bloqueada por carecer de ese estado; un reenvío no reconstruye su historial ni garantiza recuperación. Las cuentas con estado válido y token antiguo necesitan asimismo revisión; se conservan sus cuotas y se revoca el token inseguro, sin prometer que puedan reenviar automáticamente.

Antes de cualquier migración real:

1. Aprobar inventario y política de recuperación de identidad/restricciones; detener todas las operaciones de identidad, registrar hora UTC, versión del código y cuotas vigentes, sincronizar relojes y mantener la ventana de mantenimiento.
2. Obtener respaldo consistente de `usuarios` y `tokens_cuenta`, cifrado y fuera del repositorio; verificar integridad y restaurar en una base aislada. Retener evidencia de IDs afectados y estado previo en almacenamiento protegido del operador, nunca logs públicos.
3. Ensayar la cuarentena sobre copia y comparar documentos: solo debe cambiar `revocadoEn` de verificaciones inseguras activas. Verificar idempotencia, transacción y preservación de estados/restricciones. La suite incluida utiliza datos sintéticos.
4. Proponer por separado el ejecutor autorizado para base real: hoy no existe comando de migración real y la función lo rechaza. Revisar volumen, lotes y duración transaccional antes de adaptarla a datos reales.
5. Para recuperar una cuenta sin garantías, exigir revisión autorizada de identidad/restricciones y una política aprobada de inicialización conservadora y espera de la mayor ventana previa/nueva. No asignar contadores cero ni crear un token ficticio para eludir el bloqueo. HMAC anterior no puede convertirse a v2 sin el código; requiere un flujo de nueva emisión aprobado. No activar automáticamente cuentas verificadas ni restringidas.
6. Ante error, la transacción revierte. Tras commit, no restaurar tokens revocados a vigentes: restablecer datos íntegros desde respaldo solo en entorno aislado y reconciliar bajo mantenimiento. La recuperación segura de acceso es una nueva emisión autorizada cuando exista dicho flujo, no un rollback que reviva códigos. Conservar respaldo y evidencia hasta cerrar la revisión.

### Origen y proxies

**Activo:** socket directo (`request.socket.remoteAddress`) y modo configurado por servidor. El futuro adaptador HTTP debe usar ese dato, nunca `request.ip` bajo confianza implícita ni un booleano tomado del cuerpo/cabeceras. Express conserva su configuración inicial sin confianza global en proxies. IPv4 decimal válida se conserva; IPv6 se canoniza/comprime en minúsculas; IPv4 mapeada, decimal o hexadecimal, se unifica con IPv4. Se rechazan zonas `%`, puertos, listas, valores vacíos y direcciones inválidas. Se limita por dirección exacta; la agregación por prefijo IPv6 requiere decisión posterior por sus efectos sobre usuarios/NAT.

**Propuesto y deshabilitado:** antes de un proxy, documentar cada salto y ruta alternativa, CIDR/IP exactos del ingress, aislamiento de red del backend, familia de direcciones, cabecera única y reglas de sustitución. El borde debe eliminar cabeceras aportadas por clientes y emitir su propia cadena. Validar el socket contra una lista explícita; recorrer cadenas de derecha a izquierda retirando solo saltos confiables y detenerse en el primer no confiable. No elegir el primer valor arbitrariamente ni confiar solo por cantidad de saltos cuando existan rutas distintas. Rechazar cadenas ambiguas, longitud excesiva, duplicados conflictivos o discrepancias entre cabeceras; normalizar cada dirección antes de compararla. `Forwarded` necesita parser estricto de comillas/IPv6 si fuera la cabecera elegida. Probar múltiples proxies, bypass directo y saltos no confiables con la topología real. No hay lista ni extractor proxy habilitados; `behindProxy=true` falla cerrado. Las cabeceras `X-Forwarded-For`, `Forwarded` y `X-Real-IP` no participan en el origen directo.

### Redis: continuidad y cuarentena

Se exige Redis primario, AOF habilitado, `appendfsync always`, `noeviction`, escritura y última reescritura AOF sin error, carga terminada y uptime al menos igual a la mayor ventana configurada (por defecto 3600 segundos). Se comprueba el `run_id` antes/después de EVAL; cambios o errores se traducen a indisponibilidad genérica sin bypass. Una cuarentena rechazada no ejecuta EVAL. Un EVAL que falla o cuyo resultado queda incierto puede haber consumido cuota: se conserva el rechazo.

Un reinicio limpio con AOF recuperado **no** permite saltar la espera. El diagnóstico informa segundos restantes únicamente cuando el estado es comprobable; un estado incierto no se convierte en espera supuestamente segura. El uptime no detecta restauraciones/borrados administrativos, reemplazos antiguos o cambios de clave, namespace y cuotas. Ante esos cambios se requiere bloqueo externo coordinado durante la mayor ventana antigua/nueva; no rotar claves ni reinicializar Redis para recuperar disponibilidad.

Propuesta pendiente: identidad de despliegue/generación y evidencia durable externa al Redis restaurable, con control de exclusión de escritores, checkpoints confirmados, reloj/antirollback, configuración vinculada y validación por todas las instancias. Solo una prueba de continuidad que cubra fallos y restauraciones podría distinguir un reinicio seguro y justificar otra política. No se implementó ni aprobó esa excepción. INFO/CONFIG GET exigen permisos ACL de lectura; denegarlos produce fallo cerrado. Definir TLS, ACL restringida a claves/operaciones necesarias, monitoreo de AOF y política de recuperación antes de producción.

### Configuración y bloqueos antes de HTTP

Desarrollo y test requieren MongoDB replica set para transacciones, las tres claves independientes canónicas de 32 bytes en base64, issuer/audience/TTL, HMAC de códigos, cuotas válidas, Redis autenticado y namespace. Las cuotas actuales se conservan. La validación detecta formato/diversidad básica y reutilización, pero no certifica entropía ni custodia de claves. `.env` no se modifica.

Producción exige adicionalmente Redis TLS (`rediss://`) y namespace explícito diferente de `development`; el arranque continúa bloqueado sin proveedor de correo aprobado. Antes de publicar también deben verificarse índices y datos reales, recuperación de heredados, entrega durable e idempotente sin nueva colección no autorizada, topología/red/TLS/ACL y política de origen, obligatoriedad de fachada con limitador, contratos y mapeo HTTP que no revele existencia de cuentas, reloj sincronizado y observabilidad sanitizada. No existe un flag que publique parcialmente endpoints: los controladores siguen ausentes.

### Pruebas seguras

```powershell
npm run build
npm run lint
npm test
# Configurar las URI privadas sin mostrarlas; nunca copiar credenciales a documentación.
# LETHICS_IDENTITY_TEST_URI: MongoDB local 27018, credenciales autorizadas de prueba.
# LETHICS_REDIS_TEST_URL: Redis local 6380 de prueba autorizado.
npm test -- --detectOpenHandles
```

Sin las variables se omiten los casos de integración externa. MongoDB usa nombres aleatorios `lethics_identity_test_*` y `lethics_ops_test_*`, comprueba que no existan y solo elimina bases propias con formato verificado. Usa exclusivamente nombres de colecciones aprobados (`usuarios`, `tokens_cuenta`, `sesiones`); se retiró el marcador de colección adicional de la prueba previa. El ensayo de índices incompatibles deja ese índice intacto hasta eliminar la base temporal completa. Nunca se ejecuta la antigua prueba manual de reinicio de contenedores como parte de esta suite. Redis usa namespace/HMAC aleatorios y TTL; no ejecuta FLUSH, DEL de cuotas reales, CONFIG SET, reinicios ni cambios de volúmenes. El arranque compilado usa entorno test y se espera el cierre del subproceso para evitar recursos abiertos.

Resultado previo al refuerzo de aislamiento, verificado el 2026-11-21: `npm run build` y `npm run lint` aprobados. Suite `npm test -- --detectOpenHandles` con MongoDB y Redis configurados: **79 pruebas aprobadas, 0 fallidas, 0 omitidas; 13 suites aprobadas**, 92.83 segundos, sin advertencia de recursos abiertos. Incluye rollback de la primera revocación cuando falla la segunda y validación de claves independientes/producción. Sin variables externas, Jest omite las integraciones de infraestructura; las comprobaciones de solo lectura sobre la base real siguen informando los índices/colecciones ausentes.

Protección adicional: [integration-isolation.ts](test/integration-isolation.ts) genera un UUID antes de conectar y rechaza URI MongoDB con base `lethics` (también codificada o en mayúsculas), destinos no locales/27018 y parámetros de sustitución de base. Configura una URI de prueba segura, por ejemplo con base `admin` y `authSource=admin`; no uses la URI de desarrollo terminada en `/lethics`. Cada suite, incluido el arranque compilado, recibe su URI temporal (`lethics_bootstrap_test_*` para arranque). El helper crea y administra su MongoClient temporal. La limpieza exige nombre UUID, ausencia inicial y la identidad exacta del cliente y del objeto Db creados por ese helper; no permite acreditar bases o conexiones externas mediante claim(); rechaza otra base/conexión y no adquiere permisos si falla la preparación. Una URI insegura omite la suite con motivo sanitizado antes de conectar. Redis genera un namespace `test_<aleatorio>` de hasta 32 caracteres sin aceptar overrides; las claves expiran solas, sin borrados. Nunca se ejecutan FLUSHDB ni FLUSHALL. La prueba manual antigua está bloqueada porque su limpieza entre ejecuciones no acredita propiedad.

Archivos adicionales de protección de pruebas: [integration-isolation.ts](test/integration-isolation.ts), [integration-isolation.spec.ts](test/integration-isolation.spec.ts) y [replica.integration.cjs](test/replica.integration.cjs) (deshabilitado).

Correcciones finales del incremento 4:

- `inspectLegacySecurity().blockedUsers` cuenta exclusivamente cuentas no verificadas sin estado de verificación válido. Una fecha BSON/JavaScript Date válida en `verificadoEn` excluye la cuenta de ese conteo, incluso si el estado falta o es parcial. Un string o fecha inválida no acredita verificación. El inventario no modifica documentos ni concede acceso; el análisis de tokens inseguros y la cuarentena conservan sus reglas.
- `compatibleIdentityIndex` rechaza `hidden: true` como incompatibilidad operativa, sin eliminar, revelar ni modificar el índice. Su remediación requiere un cambio autorizado separado.
- El helper temporal crea su propio `MongoClient` mediante `open()` y devuelve el cliente/base vinculados. No admite conexiones externas mediante `claim`. Mongoose utiliza ese mismo cliente gestionado; cada ensayo adicional obtiene un scope y cliente nuevos. `cleanup(db, client)` exige identidad exacta de ambos y el nombre UUID; otra conexión al mismo nombre también se rechaza. `close()` limpia únicamente la base propia y cierra el cliente en finally; conexión fallida, colisión o inventario no confirmado no conceden propiedad. No se borra ninguna base si la preparación falla.
- `mongodb` es dependencia directa fijada exactamente a **6.20.0** en manifiesto y lockfile. Es la misma versión instalada y compartida con Mongoose; no se actualizaron otras dependencias.

Archivos de estas correcciones: [legacy-security.ts](src/modules/identity/infrastructure/legacy-security.ts), [identity-indexes.ts](src/modules/identity/infrastructure/identity-indexes.ts), [integration-isolation.ts](test/integration-isolation.ts), [integration-isolation.spec.ts](test/integration-isolation.spec.ts), [legacy-security.spec.ts](test/legacy-security.spec.ts) (nuevo), [identity-operations-safety.spec.ts](test/identity-operations-safety.spec.ts), [identity-ops.integration.spec.ts](test/identity-ops.integration.spec.ts), [identity.integration.spec.ts](test/identity.integration.spec.ts), [bootstrap.integration.spec.ts](test/bootstrap.integration.spec.ts), [package.json](package.json), [package-lock.json](package-lock.json), este README y [arquitectura.md](docs/arquitectura.md) (ignorado por Git).

Validación de las correcciones finales: `npm run build` y `npm run lint` aprobados; `npm test -- --detectOpenHandles` con MongoDB/Redis aislados: **104 pruebas aprobadas, cero fallidas/omitidas, 15 suites**, 108.103 segundos, sin advertencias de recursos abiertos. `npm ls mongodb mongoose --all` confirma mongodb 6.20.0 directo y compartido con Mongoose, sin actualizaciones adicionales. Los resultados anteriores de 79/89 pruebas describen ejecuciones previas a estas correcciones.

Verificación después del refuerzo: build y lint aprobados; `npm test -- --detectOpenHandles` con URI inicial de prueba `/admin` y destinos UUID generados por cada suite: **89 pruebas aprobadas, cero fallidas/omitidas; 14 suites aprobadas**, 96.809 segundos, sin advertencia de recursos abiertos. Las 10 pruebas nuevas de aislamiento no necesitan conexión externa. El ensayo manual de reinicio/limpieza entre procesos se omite deliberadamente porque no satisface propiedad dentro de la misma ejecución.

Archivos de este incremento:

| Estado | Archivos |
|---|---|
| Creados: operación | [identity-indexes.ts](src/modules/identity/infrastructure/identity-indexes.ts), [legacy-security.ts](src/modules/identity/infrastructure/legacy-security.ts), [redis-readiness.ts](src/infrastructure/rate-limit/redis-readiness.ts), [identity-ops.cli.ts](src/operations/identity-ops.cli.ts) |
| Creados: pruebas | [identity-operations-safety.spec.ts](test/identity-operations-safety.spec.ts), [identity-ops.integration.spec.ts](test/identity-ops.integration.spec.ts), [redis-fail-closed.spec.ts](test/redis-fail-closed.spec.ts), [redis-readiness.spec.ts](test/redis-readiness.spec.ts) |
| Modificados: aplicación | [registration.service.ts](src/modules/identity/application/registration.service.ts), [verify-email.service.ts](src/modules/identity/application/verify-email.service.ts), [resend-verification.service.ts](src/modules/identity/application/resend-verification.service.ts), [identity.schemas.ts](src/modules/identity/infrastructure/schemas/identity.schemas.ts), [origin-rate-limit.service.ts](src/infrastructure/rate-limit/origin-rate-limit.service.ts) |
| Modificados: pruebas | [bootstrap.integration.spec.ts](test/bootstrap.integration.spec.ts), [identity.integration.spec.ts](test/identity.integration.spec.ts), [origin-rate-limit.spec.ts](test/origin-rate-limit.spec.ts), [redis.integration.spec.ts](test/redis.integration.spec.ts) |
| Modificados: operación/documentación | [package.json](package.json), [README.md](README.md), [arquitectura.md](docs/arquitectura.md) (local, ignorado por Git) |

## Incremento 5: endpoints HTTP de identidad

**Implementado:** `AuthHttpModule` incorpora los contratos siguientes reutilizando `IdentityOperationsService`, registro/verificación/reenvío transaccionales y el limitador Redis. **Estado local verificado:** no existe activación explícita de HTTP ni selección/configuración SMTP; las tres rutas permanecen bloqueadas con 503 y ausentes de Swagger. No se editó `.env`, no se enviaron mensajes externos y no se prepararon índices en desarrollo.

| Ruta POST | Entrada | Resultado con operación habilitada y disponible |
|---|---|---|
| `/api/v1/auth/register` | `nombre`, `correo`, `contraseña` | 202 `{"message":"Solicitud recibida."}` |
| `/api/v1/auth/verify` | `correo`, `codigo` (string de seis dígitos) | 200 `{"message":"Correo verificado."}`; 400 si no puede verificarse |
| `/api/v1/auth/resend` | `correo` | 202 `{"message":"Solicitud recibida."}` |

Los DTO son independientes. Normalizan correo con trim/minúsculas; nombre se recorta y exige contenido. Se rechazan propiedades extra, incluido `rol`, en las tres rutas. El rol se asigna exclusivamente como `estudiante` en el servicio existente. Como límites de tamaño de entrada se admiten hasta 200 caracteres de nombre, 254 de correo y 1024 de contraseña; la contraseña no se recorta ni normaliza. No se introduce una nueva política de longitud mínima más allá de la entrada no vacía existente. No se devuelven usuarios, hashes, códigos, JWT ni sesiones.

Registro y reenvío retornan el mismo 202 sin confirmar existencia, estado de cuenta, límites por cuenta ni entrega. Un duplicado concurrente de correo conserva esa respuesta. Correo inexistente/verificado, reenvío antes de 60 segundos y restricciones de cuenta no revelan su condición. Una incompatibilidad heredada conocida mantiene el bloqueo y la respuesta neutra de reenvío. La verificación utiliza el mismo 400 público para código incorrecto, vencido, consumido, revocado o restringido; errores de forma del DTO también son 400. Estos contratos evitan enumeración explícita por contenido/estado normal de respuesta; no garantizan tiempos de respuesta constantes, pues la escritura y el envío síncrono tienen costos diferentes.

### Protección y activación

El guard comprueba configuración, toma exclusivamente `request.socket.remoteAddress` y obtiene una autorización interna de la fachada tras consumir Redis. La autorización está vinculada a operación/origen/modo y se consume una sola vez; se guarda con un símbolo del servidor y nunca se acepta ni serializa desde el cliente. Así, los DTO inválidos también consumen cuota de origen y el caso de uso no la descuenta dos veces. Si Redis falla, no se consultan índices ni cuentas. No hay bypass en memoria.

Después de Redis se comprueban en lectura los dos índices obligatorios antes de permitir operaciones sobre correos y tokens; registro conserva además su comprobación interna para los demás consumidores. Se rechazan ausencias, índices ocultos o incompatibilidades; no se instalan ni alteran índices. Se preservan transacciones, HMAC v2, propósito, expiración por reloj de servidor, consumo único, cinco fallos, 60 segundos, revocación previa y ventanas/cuotas persistentes. Reenviar no borra fallos de cuenta ni del token anterior; el nuevo token mantiene su contador propio, según el contrato existente.

| Configuración | Comportamiento |
|---|---|
| `AUTH_HTTP_ENABLED=false` o ausente | Las tres rutas responden 503 y no aparecen en Swagger |
| `AUTH_BEHIND_PROXY=true` | Las tres rutas bloqueadas; la política de proxies sigue sin implementarse |
| HTTP activado, sin adaptador SMTP real | Registro/reenvío bloqueados; verify puede operar con índices, MongoDB y Redis válidos |
| HTTP activado y SMTP configurado | Registro/reenvío comprueban además conexión/TLS/autenticación SMTP antes de escribir |
| Redis, índices, MongoDB o comprobación SMTP indisponibles | 503 sanitizado mediante el filtro existente |
| Cuota por origen excedida | 429 `Límite de solicitudes alcanzado`, antes de consultar cuentas |

`AUTH_BEHIND_PROXY=false` solo corresponde a un despliegue directo cuya topología se haya comprobado. El cliente no controla ese indicador. No se procesan `X-Forwarded-For`, `Forwarded`, `X-Real-IP` ni `request.ip`; la normalización IPv4/IPv6 y el comportamiento fail closed siguen en el limitador existente. No se activa confianza global en proxies.

Swagger publica únicamente rutas activadas por configuración y capacidad real del adaptador; un fallo posterior de infraestructura se informa con el 503 documentado. La documentación se construye al iniciar: los cambios operativos de configuración requieren reinicio del proceso. Verify no necesita SMTP para consumir un código existente, pero conserva todas las demás defensas. El 200 de verify no inicia sesión ni habilita acceso mediante credenciales; no se añadieron rutas educativas, login, refresh, logout, recuperación ni administración. Cualquier acceso futuro a contenido protegido deberá comprobar la verificación con autenticación/autorización propias.

### SMTP independiente del proveedor

Se agrega Nodemailer **10.6.1**, con tipos propios, sin cambiar las demás versiones. No se selecciona servicio comercial. Variables nuevas (solo marcadores comentados en `.env.example`):

- `VERIFICATION_MAIL_TRANSPORT=disabled` por defecto; seleccionar `smtp` únicamente para un servidor autorizado.
- `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASSWORD`, `SMTP_FROM` obligatorias al seleccionar SMTP.
- `SMTP_SECURE=true` por defecto para TLS implícito (habitualmente 465). Para STARTTLS (habitualmente 587), usar false: el adaptador exige la actualización TLS, nunca continúa en claro. Los certificados se validan y se requiere TLS 1.2 o superior.

El adaptador limita tiempos de conexión/saludo/socket/DNS; desactiva logs de protocolo, debug, pool y acceso a archivos/URLs. Emisor/destinatario y código se validan; el mensaje es texto fijo con código y vigencia, sin contenido HTML del cliente. Comprueba aceptación del destinatario por SMTP; esto no certifica entrega final a la bandeja. La comprobación previa verifica conexión, TLS y autenticación sin enviar un correo. Véase la [documentación oficial de SMTP de Nodemailer](https://nodemailer.com/smtp).

En `NODE_ENV=test`, la fábrica siempre devuelve el buzón de pruebas y nunca construye una conexión SMTP real, aunque existan variables SMTP heredadas. Ese buzón no habilita registro/reenvío públicos. Los ensayos HTTP que necesitan esas rutas sustituyen explícitamente el transporte por un mock dentro del adaptador SMTP; todos los mensajes observados en esas pruebas son simulados. En desarrollo sin SMTP el adaptador deshabilitado ahora rechaza el envío, en lugar de descartarlo como si hubiera tenido éxito. Producción sin SMTP conserva el bloqueo de inicio existente.

Si falla el SMTP antes de la transacción, la operación responde 503 y no escribe. Si falla después del commit, usuario/token permanecen guardados y sin verificar: se registra únicamente el evento fijo `Entrega de verificación no confirmada`, sin destinatario, código, credenciales ni excepción original. La respuesta sigue siendo 202 `Solicitud recibida.` para evitar enumeración; nunca afirma entrega. No hay cola durable, reintento automático ni nueva colección. La recuperación disponible es solicitar otro código después de 60 segundos, respetando cuotas; no se garantiza recuperación para cuentas heredadas incompatibles.

### Validación y límites de este incremento

Build y lint aprobados. Ejecución focalizada con `--detectOpenHandles`: **52 pruebas aprobadas, 0 fallidas, 0 omitidas, 7 suites**, 27.811 segundos. Se ejecutaron los cuatro archivos nuevos y las regresiones pertinentes de fachada, DTO/configuración HTTP; no se repitió toda la suite histórica. Incluye HTTP con servicios reales y MongoDB/Redis aislados: registro concurrente, rol fijo, consumo único, cinco fallos, 60 segundos, revocación y preservación de cuotas, y fallo SMTP posterior al commit. El transporte SMTP estuvo simulado, sin red ni correos externos. Sin variables seguras de integración se omiten los cuatro casos del archivo HTTP integrado; no se sustituyen por pruebas sobre `lethics`. La limpieza solo afecta el UUID propio y Redis usa namespace exclusivo con TTL, sin FLUSH ni borrado de cuotas reales. No se observaron recursos abiertos.

Para repetir únicamente esta validación con las variables de prueba seguras ya configuradas:

```powershell
npm run build
npm run lint
npm test -- --runTestsByPath test/auth-http.spec.ts test/smtp-verification.spec.ts test/identity-http-permits.spec.ts test/auth-http.integration.spec.ts test/identity-operations.spec.ts test/verification-foundation.spec.ts test/foundation.spec.ts --detectOpenHandles
```

Pendiente antes de una activación real: SMTP/identidad del remitente autorizados y custodia de secretos, prueba controlada de entrega real fuera de las pruebas automáticas, preparación autorizada de índices y revisión de datos/heredados, aceptación o resolución del riesgo de entrega sin cola durable, topología directa segura/TLS/ACL y sincronización de relojes. No se tomaron estas decisiones ni se modificó infraestructura. La activación requiere que el operador configure explícitamente HTTP; no se realizó en este incremento.

### Archivos del incremento 5

| Estado | Archivos |
|---|---|
| Creados: HTTP | [auth-http.module.ts](src/modules/auth/auth-http.module.ts), [auth.controller.ts](src/modules/auth/auth.controller.ts), [auth-http.guard.ts](src/modules/auth/auth-http.guard.ts), [auth-http.policy.ts](src/modules/auth/auth-http.policy.ts), [auth-http.errors.ts](src/modules/auth/auth-http.errors.ts), [resend-verification.dto.ts](src/modules/identity/presentation/dto/resend-verification.dto.ts) |
| Creados: correo | [smtp-verification-mailer.ts](src/modules/identity/infrastructure/smtp-verification-mailer.ts), [verification-mailer.factory.ts](src/modules/identity/infrastructure/verification-mailer.factory.ts) |
| Creados: pruebas | [auth-http.spec.ts](test/auth-http.spec.ts), [auth-http.integration.spec.ts](test/auth-http.integration.spec.ts), [smtp-verification.spec.ts](test/smtp-verification.spec.ts), [identity-http-permits.spec.ts](test/identity-http-permits.spec.ts) |
| Modificados: identidad | [identity.module.ts](src/modules/identity/identity.module.ts), [identity-operations.service.ts](src/modules/identity/application/identity-operations.service.ts), [registration.service.ts](src/modules/identity/application/registration.service.ts), [resend-verification.service.ts](src/modules/identity/application/resend-verification.service.ts), [verify-email.service.ts](src/modules/identity/application/verify-email.service.ts) (comentario), [verification-mailer.ts](src/modules/identity/application/verification-mailer.ts), [development-verification-mailer.ts](src/modules/identity/infrastructure/development-verification-mailer.ts), [register.dto.ts](src/modules/identity/presentation/dto/register.dto.ts), [verify-email.dto.ts](src/modules/identity/presentation/dto/verify-email.dto.ts) |
| Modificados: arranque/configuración | [app.module.ts](src/app.module.ts), [configure-app.ts](src/configure-app.ts), [environment.ts](src/config/environment.ts), [.env.example](.env.example), [package.json](package.json), [package-lock.json](package-lock.json), este README y [arquitectura.md](docs/arquitectura.md) (local, ignorado por Git) |
