import { Admin, Db, MongoClient } from 'mongodb';
import { createMongoTestScope, createRedisTestTarget, optionalMongoTestScope, optionalRedisTestTarget } from './integration-isolation';

describe('Protección de destinos de integración sin conexiones externas', () => {
  it.each(['lethics', '%6cethics', 'LETHICS'])('rechaza URI de base real %s antes de conectar', (name) => {
    expect(() => createMongoTestScope(`mongodb://localhost:27018/${name}?authSource=admin`, 'identity')).toThrow('rechazado');
  });
  it.each(['mongodb://localhost:27017/admin', 'mongodb://remote.invalid:27018/admin', 'mongodb://localhost:27018/admin?dbName=lethics'])('rechaza otros destinos inseguros', (uri) => {
    expect(() => createMongoTestScope(uri, 'ops')).toThrow('rechazado');
  });
  it('genera UUID distinto y sustituye la base de todos los consumidores', () => {
    const a = createMongoTestScope('mongodb://localhost:27018/admin?authSource=admin', 'bootstrap');
    const b = createMongoTestScope('mongodb://localhost:27018/admin?authSource=admin', 'bootstrap');
    expect(a.dbName).toMatch(/^lethics_bootstrap_test_[a-f0-9]{32}$/);
    expect(a.dbName).not.toBe(b.dbName);
    expect(new URL(a.uri).pathname).toBe(`/${a.dbName}`);
    expect(new URL(a.uri).searchParams.get('authSource')).toBe('admin');
  });
  describe('Conexiones administradas por el helper', () => {
    beforeEach(() => {
      jest.spyOn(MongoClient.prototype, 'connect').mockImplementation(async function (this: MongoClient) { return this; });
      jest.spyOn(MongoClient.prototype, 'close').mockResolvedValue();
      jest.spyOn(Admin.prototype, 'listDatabases').mockResolvedValue({ databases: [], ok: 1 });
      jest.spyOn(Db.prototype, 'dropDatabase').mockResolvedValue(true);
    });
    afterEach(() => jest.restoreAllMocks());

    it('crea su cliente, vincula la base y cierra sin aceptar propiedad externa', async () => {
      const scope = createMongoTestScope('mongodb://localhost:27018/admin', 'ops');
      const { db, client } = await scope.open();
      expect(db.client).toBe(client);
      expect(db.databaseName).toBe(scope.dbName);
      expect(scope).not.toHaveProperty('claim');
      await expect(scope.open()).rejects.toThrow('ya iniciada');
      expect(MongoClient.prototype.connect).toHaveBeenCalledTimes(1);
      await scope.close();
      expect(Db.prototype.dropDatabase).toHaveBeenCalledTimes(1);
      expect(MongoClient.prototype.close).toHaveBeenCalled();
      await expect(scope.cleanup(db, client)).rejects.toThrow('sin propiedad');
      await scope.close();
      expect(Db.prototype.dropDatabase).toHaveBeenCalledTimes(1);
    });
    it('rechaza otra conexión al mismo nombre, otro cliente, otra base y otra ejecución', async () => {
      const scope = createMongoTestScope('mongodb://localhost:27018/admin', 'ops');
      const { db, client } = await scope.open();
      const otherClient = new MongoClient(scope.uri);
      await expect(scope.cleanup(otherClient.db(scope.dbName), otherClient)).rejects.toThrow('sin propiedad');
      await expect(scope.cleanup(db, otherClient)).rejects.toThrow('sin propiedad');
      await expect(scope.cleanup(client.db(scope.dbName), client)).rejects.toThrow('sin propiedad');
      await expect(scope.cleanup(client.db('lethics'), client)).rejects.toThrow('no coincide');
      const other = createMongoTestScope('mongodb://localhost:27018/admin', 'ops');
      await expect(other.cleanup(db, client)).rejects.toThrow('no coincide');
      expect(Db.prototype.dropDatabase).not.toHaveBeenCalled();
      await scope.cleanup(db, client);
      expect(Db.prototype.dropDatabase).toHaveBeenCalledTimes(1);
      await scope.close();
    });
    it('rechaza bases existentes y limpia recursos sin conceder propiedad', async () => {
      const scope = createMongoTestScope('mongodb://localhost:27018/admin', 'ops');
      jest.mocked(Admin.prototype.listDatabases).mockResolvedValueOnce({ databases: [{ name: scope.dbName, sizeOnDisk: 1, empty: false }], ok: 1 });
      await expect(scope.open()).rejects.toThrow('existente');
      const otherClient = new MongoClient(scope.uri);
      await expect(scope.cleanup(otherClient.db(scope.dbName), otherClient)).rejects.toThrow('sin propiedad');
      await scope.close();
      expect(Db.prototype.dropDatabase).not.toHaveBeenCalled();
      expect(MongoClient.prototype.close).toHaveBeenCalled();
    });
    it('cierra el cliente si falla la conexión y nunca borra una base', async () => {
      const scope = createMongoTestScope('mongodb://localhost:27018/admin', 'ops');
      jest.mocked(MongoClient.prototype.connect).mockRejectedValueOnce(new Error('fallo sintético'));
      await expect(scope.open()).rejects.toThrow('fallo sintético');
      await scope.close();
      expect(Db.prototype.dropDatabase).not.toHaveBeenCalled();
      expect(MongoClient.prototype.close).toHaveBeenCalled();
    });
    it('no concede propiedad si el inventario de bases no confirma éxito', async () => {
      const scope = createMongoTestScope('mongodb://localhost:27018/admin', 'ops');
      jest.mocked(Admin.prototype.listDatabases).mockResolvedValueOnce({ databases: [], ok: 0 });
      await expect(scope.open()).rejects.toThrow('acreditar aislamiento');
      await scope.close();
      expect(Db.prototype.dropDatabase).not.toHaveBeenCalled();
      expect(MongoClient.prototype.close).toHaveBeenCalled();
    });
    it('cierra el cliente aunque falle la limpieza de su base', async () => {
      const scope = createMongoTestScope('mongodb://localhost:27018/admin', 'ops');
      await scope.open();
      jest.mocked(Db.prototype.dropDatabase).mockRejectedValueOnce(new Error('fallo sintético de limpieza'));
      await expect(scope.close()).rejects.toThrow('fallo sintético de limpieza');
      expect(MongoClient.prototype.close).toHaveBeenCalled();
    });
  });
  it('Redis genera namespace test exclusivo, dentro del límite configurado', () => {
    const a = createRedisTestTarget('redis://:test-only@localhost:6380');
    const b = createRedisTestTarget('redis://:test-only@localhost:6380');
    expect(a.namespace).toMatch(/^test_[a-f0-9]{27}$/);
    expect(a.namespace).not.toBe(b.namespace);
    expect(() => createRedisTestTarget('redis://localhost:6380/lethics')).toThrow('rechazado');
  });
  it('omite destinos inseguros con un motivo sanitizado', () => {
    const warning = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      expect(optionalMongoTestScope('mongodb://user:private-secret@localhost:27018/lethics', 'identity')).toBeUndefined();
      expect(optionalRedisTestTarget('redis://:private-secret@remote.invalid:6380')).toBeUndefined();
      expect(warning).toHaveBeenCalledTimes(2);
      expect(JSON.stringify(warning.mock.calls)).not.toContain('private-secret');
    } finally { warning.mockRestore(); }
  });
});
