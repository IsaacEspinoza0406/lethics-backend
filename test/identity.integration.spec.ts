import { randomUUID } from 'node:crypto';
import mongoose, { Connection } from 'mongoose';
import { SesionSchema, TokenCuentaSchema, UsuarioSchema } from '../src/modules/identity/infrastructure/schemas/identity.schemas';

const uri = process.env.LETHICS_IDENTITY_TEST_URI;
const integration = uri ? describe : describe.skip;

integration('Persistencia de identidad aislada', () => {
  const dbName = `lethics_identity_test_${randomUUID().replace(/-/g, '')}`;
  let connection: Connection;
  let ownsDatabase = false;
  beforeAll(async () => {
    const address = new URL(uri!);
    if (address.protocol !== 'mongodb:' || !['localhost', '127.0.0.1'].includes(address.hostname) || address.port !== '27018') throw new Error('Integration tests require local MongoDB on port 27018');
    connection = await mongoose.createConnection(uri!, { dbName, serverSelectionTimeoutMS: 5000 }).asPromise();
    const databases = await connection.db!.admin().listDatabases();
    if (databases.databases.some((db) => db.name === dbName)) throw new Error('Test database already exists');
    await connection.db!.createCollection('identity_test_marker');
    ownsDatabase = true;
  });
  afterAll(async () => {
    if (connection) {
      if (ownsDatabase && /^lethics_identity_test_[a-f0-9]{32}$/.test(dbName) && connection.name === dbName) await connection.dropDatabase();
      await connection.close();
    }
  });
  it('crea índices y rechaza duplicados, conservando hashes fuera de las consultas y serializaciones', async () => {
    const User = connection.model('Usuario', UsuarioSchema);
    const Token = connection.model('TokenCuenta', TokenCuentaSchema);
    const Session = connection.model('Sesion', SesionSchema);
    await Promise.all([User.createIndexes(), Token.createIndexes()]);
    const userData = { correo: ' TEST@EXAMPLE.INVALID ', contraseñaHash: 'hash-ficticio', nombre: 'Ejemplo', rol: 'rol-ficticio' };
    const user = await User.create(userData);
    await expect(User.create({ ...userData, correo: 'test@example.invalid' })).rejects.toMatchObject({ code: 11000 });
    const tokenData = { usuarioId: user._id, tokenHash: 'token-ficticio', tipo: 'verificacion', creadoEn: new Date(), expiraEn: new Date() };
    const token = await Token.create(tokenData);
    await expect(Token.create(tokenData)).rejects.toMatchObject({ code: 11000 });
    const session = await Session.create({ usuarioId: user._id, refreshTokenHash: 'refresh-ficticio', expiraEn: new Date(), revocadaEn: null });
    expect(await User.findById(user._id).lean()).not.toHaveProperty('contraseñaHash');
    expect(await Token.findById(token._id).lean()).not.toHaveProperty('tokenHash');
    expect(await Session.findById(session._id).lean()).not.toHaveProperty('refreshTokenHash');
    const selected = await User.findById(user._id).select('+contraseñaHash');
    expect(selected?.get('contraseñaHash')).toBe('hash-ficticio');
    expect(selected?.toJSON()).not.toHaveProperty('contraseñaHash');
    expect(await User.findById(user._id).select('+contraseñaHash').lean()).toHaveProperty('contraseñaHash');
    const selectedToken = await Token.findById(token._id).select('+tokenHash');
    const selectedSession = await Session.findById(session._id).select('+refreshTokenHash');
    expect(selectedToken?.toObject()).not.toHaveProperty('tokenHash');
    expect(selectedSession?.toJSON()).not.toHaveProperty('refreshTokenHash');
    const stored = await connection.db!.collection('tokens_cuenta').findOne({ _id: token._id });
    expect(stored?.usuarioId).toBeInstanceOf(mongoose.Types.ObjectId);
    expect(stored?.creadoEn).toBeInstanceOf(Date);
    expect((await User.collection.indexes()).some((index) => index.key.correo === 1 && index.unique)).toBe(true);
    expect((await Token.collection.indexes()).some((index) => index.key.tokenHash === 1 && index.unique)).toBe(true);
  });
});
