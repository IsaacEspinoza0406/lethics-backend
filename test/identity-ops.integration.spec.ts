import { MongoClient, Db, ObjectId, Collection } from 'mongodb';
import { inspectIdentityData, inspectIdentityIndexes, installIdentityIndexes } from '../src/modules/identity/infrastructure/identity-indexes';
import { inspectLegacySecurity, quarantineLegacyVerification } from '../src/modules/identity/infrastructure/legacy-security';
import { createMongoTestScope, optionalMongoTestScope } from './integration-isolation';

const scope = optionalMongoTestScope(process.env.LETHICS_IDENTITY_TEST_URI, 'ops');
const uri = scope?.uri;
(scope ? describe : describe.skip)('Operación de identidad en bases temporales propias', () => {
  const name = scope?.dbName;
  let client: MongoClient, db: Db;
  beforeAll(async () => {
    ({ client, db } = await scope!.open());
  });
  afterAll(async () => {
    await scope!.close();
  });
  it('detecta colecciones ausentes sin crearlas; exige confirmación y colecciones existentes', async () => {
    expect((await inspectIdentityIndexes(db)).every((item) => item.status === 'missing-collection')).toBe(true);
    expect(await db.listCollections().toArray()).toHaveLength(0);
    await expect(installIdentityIndexes(db, 'no')).rejects.toThrow('Confirmación');
    await expect(installIdentityIndexes(db, `INSTALL INDEXES ${name}`)).rejects.toThrow('Precondiciones');
    // Only approved collection names, exclusively inside this fresh temporary database.
    await db.createCollection('usuarios');
    await db.createCollection('tokens_cuenta');
    expect((await inspectIdentityIndexes(db)).every((item) => item.status === 'missing')).toBe(true);
  });
  it('detecta duplicados normalizados y datos inválidos antes de cualquier instalación', async () => {
    const a = await db.collection('usuarios').insertMany([{ correo: 'duplicado@example.invalid' }, { correo: ' DUPLICADO@EXAMPLE.INVALID ' }, { correo: null }]);
    const b = await db.collection('tokens_cuenta').insertMany([{ tokenHash: 'hash-ficticio' }, { tokenHash: 'hash-ficticio' }]);
    expect(await inspectIdentityData(db)).toEqual([
      { collection: 'usuarios', invalid: 1, nonCanonical: 1, duplicates: 1 },
      { collection: 'tokens_cuenta', invalid: 0, nonCanonical: 0, duplicates: 1 },
    ]);
    await expect(installIdentityIndexes(db, `INSTALL INDEXES ${name}`)).rejects.toThrow('Precondiciones');
    expect((await inspectIdentityIndexes(db)).every((item) => item.status === 'missing')).toBe(true);
    await db.collection('usuarios').deleteMany({ _id: { $in: Object.values(a.insertedIds) } });
    await db.collection('tokens_cuenta').deleteMany({ _id: { $in: Object.values(b.insertedIds) } });
  });
  it('detecta un índice incompatible sin eliminarlo ni corregirlo', async () => {
    await db.collection('usuarios').createIndex({ correo: 1 }, { name: 'correo_1', unique: true, sparse: true });
    expect((await inspectIdentityIndexes(db))[0].status).toBe('incompatible');
    await expect(installIdentityIndexes(db, `INSTALL INDEXES ${name}`)).rejects.toThrow('Precondiciones');
    expect((await db.collection('usuarios').listIndexes().toArray()).find((item) => item.name === 'correo_1')?.sparse).toBe(true);
  });
  it('instala en otra base nueva, repite sin cambios y MongoDB rechaza duplicados', async () => {
    const freshScope = createMongoTestScope(uri!, 'ops');
    const freshName = freshScope.dbName;
    try {
      const { db: fresh } = await freshScope.open();
      await fresh.createCollection('usuarios'); await fresh.createCollection('tokens_cuenta');
      await installIdentityIndexes(fresh, `INSTALL INDEXES ${freshName}`);
      const before = await inspectIdentityIndexes(fresh);
      await installIdentityIndexes(fresh, `INSTALL INDEXES ${freshName}`);
      expect(await inspectIdentityIndexes(fresh)).toEqual(before);
      expect(before.every((item) => item.status === 'ready')).toBe(true);
      for (const [collection, field, value] of [['usuarios', 'correo', 'prueba@example.invalid'], ['tokens_cuenta', 'tokenHash', 'hash-ficticio']]) {
        await fresh.collection(collection).insertOne({ [field]: value });
        await expect(fresh.collection(collection).insertOne({ [field]: value })).rejects.toMatchObject({ code: 11000 });
      }
    } finally {
      await freshScope.close();
    }
  });
  it('revoca códigos inseguros idempotentemente y conserva usuarios, cuotas, verificación y tokens restringidos', async () => {
    const now = new Date();
    const legacy = { _id: new ObjectId(), correo: 'legacy@example.invalid', rol: 'estudiante', verificadoEn: null };
    const state = { tokenActualId: new ObjectId(), ultimaEmision: now, emisionesInicio: now, fallosInicio: now, emisiones: 5, fallos: 20, revision: 9 };
    const modern = { _id: new ObjectId(), correo: 'modern@example.invalid', seguridadVerificacion: state, verificadoEn: now };
    const partial = { _id: new ObjectId(), correo: 'partial@example.invalid', seguridadVerificacion: { fallos: 99 } };
    await db.collection('usuarios').insertMany([legacy, modern, partial]);
    const tokens = [
      { _id: new ObjectId(), usuarioId: legacy._id, tipo: 'verificacion' },
      { _id: new ObjectId(), usuarioId: partial._id, tipo: 'verificacion', versionHmac: 2, intentosFallidos: 0 },
      { _id: state.tokenActualId, usuarioId: modern._id, tipo: 'verificacion', versionHmac: 2, intentosFallidos: 5 },
      { _id: new ObjectId(), usuarioId: legacy._id, tipo: 'recuperacion' },
      { _id: new ObjectId(), usuarioId: legacy._id, tipo: 'verificacion', revocadoEn: new Date(0) },
      { _id: new ObjectId(), usuarioId: legacy._id, tipo: 'verificacion', usadoEn: new Date(0) },
    ];
    await db.collection('tokens_cuenta').insertMany(tokens);
    const usersBefore = await db.collection('usuarios').find().toArray();
    expect(await inspectLegacySecurity(db)).toEqual({ blockedUsers: 2, unsafeActiveTokens: 2 });
    await expect(quarantineLegacyVerification(client, client.db('lethics'), 'QUARANTINE lethics')).rejects.toThrow('temporal');
    await expect(quarantineLegacyVerification(client, db, 'no')).rejects.toThrow('confirmada');
    expect(await quarantineLegacyVerification(client, db, `QUARANTINE ${name}`, now)).toEqual({ revoked: 2 });
    expect(await quarantineLegacyVerification(client, db, `QUARANTINE ${name}`, now)).toEqual({ revoked: 0 });
    expect(await db.collection('usuarios').find().toArray()).toEqual(usersBefore);
    expect(await db.collection('tokens_cuenta').findOne({ _id: tokens[2]._id })).toEqual(tokens[2]);
    expect(await db.collection('tokens_cuenta').findOne({ _id: tokens[3]._id })).toEqual(tokens[3]);
    expect(await db.collection('tokens_cuenta').findOne({ _id: tokens[4]._id })).toEqual(tokens[4]);
    expect(await db.collection('tokens_cuenta').findOne({ _id: tokens[5]._id })).toEqual(tokens[5]);
    expect(await inspectLegacySecurity(db)).toEqual({ blockedUsers: 2, unsafeActiveTokens: 0 });
  });
  it('revierte la primera revocación si falla la segunda escritura de la migración', async () => {
    const owner = new ObjectId();
    const entries = [{ _id: new ObjectId(), usuarioId: owner, tipo: 'verificacion' }, { _id: new ObjectId(), usuarioId: owner, tipo: 'verificacion' }];
    await db.collection('tokens_cuenta').insertMany(entries);
    const original = Collection.prototype.updateOne;
    let calls = 0;
    const spy = jest.spyOn(Collection.prototype, 'updateOne').mockImplementation(function (this: Collection, filter, update, options) {
      if (++calls === 2) return Promise.reject(new Error('fallo sintético de migración'));
      return original.call(this, filter, update, options);
    });
    try { await expect(quarantineLegacyVerification(client, db, `QUARANTINE ${name}`)).rejects.toThrow('fallo sintético'); }
    finally { spy.mockRestore(); }
    expect(calls).toBe(2);
    expect(await db.collection('tokens_cuenta').find({ _id: { $in: entries.map((entry) => entry._id) } }).toArray()).toEqual(entries);
  });
  it('no clasifica como bloqueadas las cuentas verificadas sin estado o con estado parcial', async () => {
    const before = await inspectLegacySecurity(db);
    const entries = [
      { _id: new ObjectId(), correo: 'verified-legacy@example.invalid', verificadoEn: new Date() },
      { _id: new ObjectId(), correo: 'verified-partial@example.invalid', verificadoEn: new Date(), seguridadVerificacion: { fallos: 20 } },
      { _id: new ObjectId(), correo: 'unverified-legacy@example.invalid', verificadoEn: null },
      { _id: new ObjectId(), correo: 'unverified-partial@example.invalid', seguridadVerificacion: { revision: 0 } },
    ];
    await db.collection('usuarios').insertMany(entries);
    const after = await inspectLegacySecurity(db);
    expect(after.blockedUsers).toBe(before.blockedUsers + 2);
    expect(after.unsafeActiveTokens).toBe(before.unsafeActiveTokens);
    expect(await db.collection('usuarios').find({ _id: { $in: entries.map((entry) => entry._id) } }).toArray()).toEqual(entries);
  });
});
