# Correo SMTP e integración con frontend

La API implementa registro, verificación, reenvío, recuperación y restablecimiento. Esta guía prepara su configuración sin elegir proveedor ni activar rutas automáticamente. Las dependencias educativas se describen en la [guía de integración](INTEGRACION_BACKEND_EDUCATIVO.md).

## Configuración base

Partir de [.env.example](.env.example), sin sobrescribir un `.env` existente. Sustituir los marcadores de MongoDB/Redis y generar tres claves independientes de 32 bytes aleatorios en base64 para JWT, HMAC de verificación y HMAC del limitador. Guardar los valores reales solo en la configuración privada; no publicarlos ni reutilizarlos.

La API usa inicialmente 3000, MongoDB replica set local 27018 y Redis 6380. Conservar credenciales y volúmenes existentes. La instalación y las comprobaciones de índices/Redis se encuentran en [README](README.md#configuración).

```powershell
npm.cmd run build
npm.cmd run ops:config
```

`ops:config` valida presencia/formato y muestra nombres de campos inválidos, sin conectar a SMTP ni confirmar entrega. Su campo `publicEndpointsEnabled: false` no es una comprobación de disponibilidad de todas las rutas: esta depende de la política HTTP y sus precondiciones.

`AUTH_HTTP_ENABLED=false` es el valor inicial. Registro, reenvío y recuperación requieren además SMTP configurado. Antes de habilitar HTTP, comprobar colecciones/índices, datos compatibles y continuidad de Redis en un entorno autorizado. No reducir cuotas o cuarentena para forzar una prueba.

## SMTP estándar

Los siguientes valores son ficticios y **no constituyen un servidor operativo**. Cuando el usuario proporcione un proveedor autorizado, configurar exclusivamente el `.env` privado:

```dotenv
VERIFICATION_MAIL_TRANSPORT=smtp
SMTP_HOST=smtp.example.invalid
SMTP_PORT=465
SMTP_SECURE=true
SMTP_USER=replace_me
SMTP_PASSWORD=replace_me
SMTP_FROM=verificacion@example.invalid
```

El proveedor debe indicar host, puerto/modo TLS, credenciales SMTP y remitente autorizado. El usuario SMTP puede diferir del remitente. SMTP_FROM actualmente acepta una dirección simple válida, sin nombre de presentación ni saltos de línea. Entrecomillar secretos según la sintaxis de dotenv cuando corresponda; no introducirlos en comandos, capturas o reportes.

- **TLS implícito:** normalmente puerto 465 y `SMTP_SECURE=true`.
- **STARTTLS obligatorio:** normalmente puerto 587 y `SMTP_SECURE=false`. Este valor desactiva únicamente TLS implícito: el adaptador exige STARTTLS y rechaza su ausencia; no permite fallback a texto plano.
- Confirmar siempre modo/puerto con el proveedor. Mantener TLS mínimo 1.2 y validación del certificado. No utilizar `rejectUnauthorized=false`, `NODE_TLS_REJECT_UNAUTHORIZED=0` ni desactivar otra comprobación TLS.

La [validación de entorno](src/config/environment.ts) rechaza configuración SMTP incompleta. El [adaptador](src/modules/identity/infrastructure/smtp-verification-mailer.ts) autentica con usuario/contraseña y verifica conexión/TLS/auth antes de emitir. Solo considera aceptado un envío si el destinatario figura entre los aceptados y no hay rechazados. Es independiente de Gmail; OAuth u otros mecanismos requieren una decisión adicional. No se agregó dependencia nueva.

No utiliza pool, trazas SMTP, logs de protocolo ni contenido cargado desde archivos/URLs. DNS, conexión y saludo tienen límites de 5 segundos; socket inactivo, 10 segundos. La [política de reintentos](src/modules/identity/infrastructure/smtp-delivery-policy.ts) admite hasta dos intentos con espera de 500 ms, dentro de una ventana de admisión de 15 segundos y solo ante evidencia de fallo seguro anterior al mensaje. Autenticación, configuración, TLS, rechazos permanentes o resultado incierto tras DATA no se reintentan automáticamente. Message-ID no garantiza deduplicación.

**Aceptación SMTP no significa llegada al buzón ni lectura.** Registro/reenvío responden 202 uniforme por privacidad, incluso ante ciertos fallos posteriores al commit; no usar esa respuesta como comprobante de envío. Recuperación acepta trabajo supervisado en memoria: 202 tampoco confirma entrega. No hay entrega durable tras caída abrupta del proceso; una cola/Outbox requiere aprobación independiente.

## Mailpit local

```powershell
node scripts/mailpit.cjs serve
```

Mantener el proceso abierto. El runner crea un proyecto Docker independiente, certificados temporales y Mailpit sin relay ni volúmenes persistentes; no modifica MongoDB/Redis. Normalmente usa interfaz/API en `http://127.0.0.1:8025` y SMTP en `localhost:1025`, o informa puertos alternativos. La consulta de mensajes usa `/api/v1/messages`.

Copiar los valores impresos de SMTP y `NODE_EXTRA_CA_CERTS` a una segunda sesión PowerShell **antes de iniciar Node.js**. Las variables de sesión se asignan con `$env:VARIABLE='valor_del_runner'`; el certificado debe ser la ruta temporal concreta impresa. Usar únicamente las credenciales ficticias del runner, no las del proveedor externo. No publicar el certificado ni desactivar TLS.

Establecer `VERIFICATION_MAIL_TRANSPORT=smtp` en esa sesión y habilitar HTTP allí solo después de preparar un entorno local autorizado. Las variables de proceso prevalecen sobre `.env`; abrir una sesión nueva al terminar evita conservar overrides al preparar SMTP externo. Ctrl+C limpia el proyecto, red y certificados propios.

El [adaptador de desarrollo](src/modules/identity/infrastructure/development-verification-mailer.ts) sin SMTP rechaza envíos: no es un buzón ni simula entrega satisfactoria. En `NODE_ENV=test`, la fábrica selecciona un adaptador de pruebas; las integraciones SMTP lo sustituyen explícitamente por Mailpit, sin utilizar un proveedor externo heredado.

## Flujos y pruebas

Con Docker, MongoDB replica set, Redis y OpenSSL disponibles:

```powershell
node scripts/mailpit.cjs test
```

El runner específico prueba SMTP/política, HTTP y Mailpit con bases UUID y namespaces Redis exclusivos. No limpia lethics ni ejecuta FLUSH. Solo utiliza destinatarios example.test capturados localmente. Incluye registro, reenvío, verificación de un uso, recuperación/reset, login posterior y recorrido de sesiones/perfil; también credenciales SMTP incorrectas, rechazo permanente y resultado incierto tras DATA. No es la suite completa.

Se conservan seis dígitos, cinco minutos, máximo cinco fallos por código, reenvío desde 60 segundos, revocación anterior y cuotas persistentes. La recuperación utiliza un token independiente de un uso, inicialmente de 15 minutos; reset aplica Argon2id y revoca sesiones. Los JWT de acceso emitidos pueden seguir válidos hasta expirar, máximo 15 minutos.

Contratos del [controlador](src/modules/auth/auth.controller.ts), todos mediante POST:

- `/api/v1/auth/register`: nombre/correo/contraseña; 202 genérico.
- `/api/v1/auth/resend`: correo; 202 genérico.
- `/api/v1/auth/verify`: correo/codigo; 200 al consumir el código válido.
- `/api/v1/auth/password/forgot`: correo; 202 sin confirmar cuenta o entrega.
- `/api/v1/auth/password/reset`: token/nuevaContraseña; 200 al confirmar cambio.
- `/api/v1/auth/login`: correo/contraseña; 200 accessToken/tokenType/expiresIn y cookie HttpOnly.

Errores habituales: 400 DTO/código/token inválido; 401 credenciales inválidas; 403 origen no permitido; 415 cuando se exige JSON y llega otro tipo; 429 cuota por origen; 503 protección/configuración/dependencia no disponible. Para una regresión completa de código, usar `node scripts/mailpit.cjs suite` cuando corresponda.

## Prueba externa pendiente

Se necesitan proveedor, remitente, credenciales y un destinatario **expresamente autorizado por el usuario**. No usar su correo personal, cuentas de compañeros ni destinatarios inventados en el proveedor real. Estos ejemplos no autorizan envíos externos.

Cuando se disponga de datos y autorización:

1. Confirmar permisos de envío, verificación del remitente/dominio, TLS, cuotas y autenticación. Preparar SPF/DKIM/DMARC cuando corresponda; no se configura DNS automáticamente.
2. Guardar los valores solo en `.env` privado y validar con ops:config sin imprimir secretos. Utilizar un entorno manual autorizado y cuentas de prueba, sin datos reales; no cambiar el runner automatizado al proveedor real.
3. Comprobar índices/Redis y topología antes de activar HTTP explícitamente. La disponibilidad SMTP se comprueba antes de emitir; autenticación/TLS fallidos deben impedir la operación.
4. Registrar la cuenta del destinatario autorizado, comprobar aceptación en el proveedor y revisar efectivamente buzón/spam. Introducir el código solo en formulario/JSON, nunca en URL/logs/reportes.
5. Probar reenvío respetando 60 segundos y cuotas; consumir solo el código vigente. Completar recuperación/reset y comprobar login con contraseña nueva y rechazo de la anterior.
6. Registrar resultados sin códigos, tokens, contraseñas ni cabeceras privadas. Distinguir aceptación SMTP, llegada observada y lectura; no iniciar reintentos ciegos ni declarar entrega sin observarla.

No se realizó esta prueba externa ni se configuró un proveedor real durante la preparación documental.

## Frontend y cookies

La API usa 3000 por defecto. Acordar el puerto del frontend con su responsable: 3001 es solo un ejemplo para evitar colisión en el mismo equipo. No se presupone su script ni se modifica su repositorio.

`AUTH_BROWSER_ORIGIN` debe coincidir exactamente con el origen enviado por el navegador: esquema/host/puerto, sin ruta ni barra final. Ejemplo: `http://localhost:3001`. localhost y 127.0.0.1 no son intercambiables. Login/forgot/reset validan Origin si se presenta; refresh/logout lo exigen también en CLI/SSR. Las operaciones de sesión exigen JSON y rechazan `Sec-Fetch-Site: cross-site`. Register/verify/resend conservan su política existente.

**Origin no habilita CORS.** Dos puertos distintos son orígenes distintos, por lo que configurar el ejemplo no basta para consumir la API directamente desde JavaScript. No hay CORS global abierto ni proxy confiable habilitado. Acordar una política de origen exacto/credenciales o una topología del mismo origen/proxy aprobada antes de integrar. `credentials: include` por sí solo no resuelve CORS.

La cookie `lethics_refresh` es HttpOnly, host-only, Path `/api/v1/auth`, SameSite Strict. Secure=false solo es para HTTP local; producción exige Secure=true y HTTPS. El refresh no se devuelve en JSON. Mantener access en memoria, sin localStorage/sessionStorage; enviarlo como Authorization Bearer a rutas privadas. Coordinar refresh single-flight entre pestañas: reutilizar un refresh rotado puede revocar la familia.

No se incorpora BFF/proxy automáticamente: acordar preservación de Origin, Cookie/Set-Cookie, host/path e identificación del origen. `AUTH_BEHIND_PROXY=true` actualmente bloquea auth, no habilita trust proxy. No confiar en Forwarded/X-Forwarded-For del cliente. Continuidad/retención de Redis y sesiones, entrega durable y políticas de despliegue siguen pendientes.
