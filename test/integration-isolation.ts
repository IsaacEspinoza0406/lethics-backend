import { randomUUID } from 'node:crypto';
import { Db, MongoClient } from 'mongodb';

/** Each capability belongs to one execution and one exact Db object. No persisted ownership bypass. */
export function createMongoTestScope(uri: string, prefix: 'identity' | 'ops' | 'bootstrap') {
  const dbName = `lethics_${prefix}_test_${randomUUID().replace(/-/g, '')}`;
  const address = new URL(uri);
  const sourceDatabase = decodeURIComponent(address.pathname).replace(/^\//, '');
  if (address.protocol !== 'mongodb:' || !['localhost', '127.0.0.1'].includes(address.hostname) || address.port !== '27018' ||
      sourceDatabase.includes('/') || sourceDatabase.toLowerCase() === 'lethics' || address.searchParams.has('dbName')) throw new Error('Destino MongoDB de integración rechazado');
  address.pathname = `/${dbName}`;
  let client: MongoClient | undefined;
  let owner: { db: Db; client: MongoClient } | undefined;
  let started = false;
  const assertTarget = (db: Db) => {
    if (db.databaseName !== dbName || !/^lethics_(identity|ops|bootstrap)_test_[a-f0-9]{32}$/.test(dbName)) throw new Error('Destino temporal no coincide');
  };
  async function cleanup(db: Db, connection: MongoClient) {
    assertTarget(db);
    if (!owner || owner.db !== db || owner.client !== connection || db.client !== connection) throw new Error('Limpieza rechazada: base, conexión o cliente sin propiedad');
    await owner.db.dropDatabase();
    owner = undefined;
  }
  return {
    dbName, uri: address.toString(),
    async open() {
      if (started) throw new Error('Conexión temporal ya iniciada');
      started = true;
      client = new MongoClient(address.toString(), { serverSelectionTimeoutMS: 5000 });
      try {
        await client.connect();
        const db = client.db(dbName);
        assertTarget(db);
        const listed = await db.admin().listDatabases();
        if (listed.ok !== 1 || !Array.isArray(listed.databases)) throw new Error('No se pudo acreditar aislamiento temporal');
        if (listed.databases.some((item) => item.name === dbName)) throw new Error('Base temporal ya existente');
        owner = { db, client };
        return { db, client };
      } catch (error) {
        await client.close();
        throw error;
      }
    },
    cleanup,
    async close() {
      try { if (owner) await cleanup(owner.db, owner.client); }
      finally { await client?.close(); }
    },
  };
}

export function optionalMongoTestScope(uri: string | undefined, prefix: 'identity' | 'ops' | 'bootstrap') {
  if (!uri) return undefined;
  try { return createMongoTestScope(uri, prefix); }
  catch { console.warn(`Integración MongoDB ${prefix} omitida: URI insegura o aislamiento no garantizado.`); return undefined; }
}

export function createRedisTestTarget(uri: string) {
  const namespace = `test_${randomUUID().replace(/-/g, '').slice(0, 27)}`;
  const address = new URL(uri);
  if (!['redis:', 'rediss:'].includes(address.protocol) || !['localhost', '127.0.0.1'].includes(address.hostname) || address.port !== '6380' || !address.password || (address.pathname && !/^\/\d+$/.test(address.pathname))) throw new Error('Destino Redis de integración rechazado');
  return { uri, namespace };
}

export function optionalRedisTestTarget(uri: string | undefined) {
  if (!uri) return undefined;
  try { return createRedisTestTarget(uri); }
  catch { console.warn('Integración Redis omitida: URI insegura o aislamiento no garantizado.'); return undefined; }
}
