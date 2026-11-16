# Lethics — Backend

Base del backend REST de Lethics. El alcance y el modelo aprobado están en [el contexto](docs/LETHICS_BACKEND_CONTEXTO.md); las decisiones de esta fase están en [arquitectura](docs/arquitectura.md). No incluye autenticación ni funcionalidades de negocio.

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

Para repetir la prueba manual de transacciones, usa una base inequívoca y nueva. La segunda orden valida persistencia después del reinicio y elimina únicamente esa base temporal, tras comprobar su contenido:

```powershell
$env:MONGODB_URI = 'mongodb://USUARIO:CLAVE@localhost:27018/lethics?authSource=admin&replicaSet=lethics-rs'
$env:LETHICS_TEST_DB = 'lethics_test_' + [guid]::NewGuid().ToString('N')
node test/replica.integration.cjs setup
docker compose -f compose.replica.yaml restart mongodb-rs
node test/replica.integration.cjs verify-and-clean
```

Usa credenciales locales con caracteres codificados para URI y conserva el nombre de la base si una prueba falla para poder inspeccionarla. El usuario de prueba debe tener permisos para listar bases, crear colecciones y eliminarlas. El replica set de un nodo permite probar transacciones multipdocumento, pero no proporciona alta disponibilidad ni sustituye un despliegue de producción.

## Pruebas de persistencia de identidad

`npm test` ejecuta las pruebas unitarias sin MongoDB y omite la integración si no está configurada. Para ejecutar la integración, inicia el replica set local de prueba y ejecuta en PowerShell:

```powershell
$env:LETHICS_IDENTITY_TEST_URI = 'mongodb://USUARIO:CLAVE@localhost:27018/admin?authSource=admin&replicaSet=lethics-rs'
npm test -- --runTestsByPath test/identity.integration.spec.ts
Remove-Item Env:LETHICS_IDENTITY_TEST_URI
```

Sustituye las credenciales por las locales, codificadas para URI. La prueba acepta únicamente el servidor local en el puerto 27018, genera una base con UUID, verifica que no exista y la elimina al terminar solo si creó su marcador. Requiere permiso para listar bases, crear índices y eliminar esa base temporal. Los hashes usados son valores ficticios. Los índices de aplicación se declaran pero no se crean automáticamente al arrancar; hay que preparar su creación controlada antes de depender de la unicidad en una base real.

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

Para ejecutar la integración aislada de Redis, configura `LETHICS_REDIS_TEST_URL` para Redis local en el puerto 6380 y ejecuta `npm test`; usa una instancia de prueba, no Redis de producción. La prueba crea claves con nombre aleatorio y vencimiento. Sin la variable la integración Redis se omite.
