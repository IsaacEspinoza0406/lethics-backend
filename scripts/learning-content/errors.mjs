// Traduce los errores del driver de MongoDB a mensajes claros en español.
// Nunca devuelve el URI de conexión: si aparece en un mensaje, se oculta.

const URI = /mongodb(?:\+srv)?:\/\/[^\s@/]+@/gi;
const scrub = (s) => String(s ?? '').replace(URI, 'mongodb://***@');

function firstWriteError(err) {
  const w = err?.writeErrors;
  if (Array.isArray(w) && w.length > 0) return w[0];
  return w && typeof w === 'object' ? w : undefined;
}

export function explainError(err) {
  const name = err?.name ?? '';
  const message = err?.message ?? String(err);
  const write = firstWriteError(err);
  const code = err?.code ?? write?.code;

  if (/ServerSelection|MongoNetwork|MongoNetworkTimeout/.test(name) || code === 'ECONNREFUSED') {
    return 'No se pudo conectar a MongoDB. Comprueba que el contenedor esté levantado (docker compose -f compose.replica.yaml up -d) y que el URI apunte a 127.0.0.1:27018.';
  }
  if (code === 18 || err?.codeName === 'AuthenticationFailed' || /authentication failed/i.test(message)) {
    return 'MongoDB rechazó la autenticación. Revisa el usuario y la contraseña del URI (con authSource=admin).';
  }
  if (code === 13 || err?.codeName === 'Unauthorized') {
    return 'El usuario del URI no tiene permisos para escribir en esa base.';
  }
  if (code === 11000) {
    const key = err?.keyPattern ?? write?.err?.keyPattern;
    return `Clave duplicada${key ? ` (índice único ${JSON.stringify(key)})` : ''}: ya existe un documento con esos valores. Si la carga iba en transacción, no quedó nada a medias.`;
  }
  if (/only allowed on a replica set|Transaction numbers/i.test(message)) {
    return 'Este MongoDB no admite transacciones (requiere replica set). Usa --no-transaction solo en una base de pruebas desechable.';
  }
  return scrub(message);
}
