# Lethics — Backend

Base del backend REST de Lethics. El alcance y el modelo aprobado están en [el contexto](docs/LETHICS_BACKEND_CONTEXTO.md); las decisiones de esta fase están en [arquitectura](docs/arquitectura.md). No incluye autenticación ni funcionalidades de negocio.

## Requisitos

Node.js 22 LTS, npm y Docker con Compose. Desde la raíz, copia `.env.example` a `.env` y reemplaza los valores de usuario y contraseña por credenciales locales propias. Ajusta `MONGO_PORT` y el puerto correspondiente en `MONGODB_URI`; codifica para URI los caracteres especiales del usuario y contraseña. No compartas `.env`.

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
