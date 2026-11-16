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
