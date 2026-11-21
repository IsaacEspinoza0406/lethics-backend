import { IndexDescriptionInfo } from 'mongodb';
import { Types } from 'mongoose';
import { compatibleIdentityIndex } from '../src/modules/identity/infrastructure/identity-indexes';
import { validVerificationState, validVerificationToken } from '../src/modules/identity/infrastructure/legacy-security';
import { RegistrationService } from '../src/modules/identity/application/registration.service';
import { randomBytes } from 'node:crypto';
import { environmentSchema } from '../src/config/environment';

describe('Precondiciones operativas de identidad', () => {
  const index: IndexDescriptionInfo = { name: 'correo_1', key: { correo: 1 }, unique: true };
  it('admite el índice histórico simple y la definición simple explícita', () => {
    expect(compatibleIdentityIndex(index, 'correo', 'correo_1')).toBe(true);
    expect(compatibleIdentityIndex({ ...index, collation: { locale: 'simple' } }, 'correo', 'correo_1')).toBe(true);
  });
  it.each([
    { unique: false }, { hidden: true }, { sparse: true }, { partialFilterExpression: { correo: { $exists: true } } },
    { collation: { locale: 'en', strength: 2 } }, { name: 'otro' }, { key: { correo: 1, rol: 1 } }, { expireAfterSeconds: 60 },
  ])('rechaza opciones incompatibles %j', (options) => {
    expect(compatibleIdentityIndex({ ...index, ...options }, 'correo', 'correo_1')).toBe(false);
  });
  it('bloquea registro antes de hash, transacción o correo cuando faltan índices', async () => {
    const indexes = jest.fn().mockResolvedValue([]);
    const service = new RegistrationService(...([{}, { collection: { indexes } }, { collection: { indexes } }, {}, {}, {}] as unknown as ConstructorParameters<typeof RegistrationService>));
    await expect(service.register({ nombre: 'Prueba', correo: 'x@example.invalid', contraseña: 'ficticia' })).rejects.toThrow('Índices');
  });
  it('rechaza estados parciales, contadores inválidos y tokens heredados', () => {
    const state = { tokenActualId: new Types.ObjectId(), ultimaEmision: new Date(), emisionesInicio: new Date(), fallosInicio: new Date(), emisiones: 5, fallos: 20, revision: 0 };
    expect(validVerificationState(state)).toBe(true);
    for (const value of [undefined, null, {}, { ...state, fallos: -1 }, { ...state, emisiones: 1.5 }, { ...state, fallosInicio: new Date(NaN) }]) expect(validVerificationState(value)).toBe(false);
    expect(validVerificationToken({ versionHmac: 2, intentosFallidos: 5 })).toBe(true);
    expect(validVerificationToken({ versionHmac: 1, intentosFallidos: 0 })).toBe(false);
    expect(validVerificationToken({ versionHmac: 2 })).toBe(false);
  });
  it('exige claves independientes y requisitos distintos en producción', () => {
    const settings = { MONGODB_URI: 'mongodb://localhost/test', JWT_ACCESS_SECRET_BASE64: randomBytes(32).toString('base64'), JWT_ACCESS_ISSUER: 'test', JWT_ACCESS_AUDIENCE: 'test', JWT_ACCESS_TTL_SECONDS: 900, VERIFICATION_CODE_HMAC_KEY_BASE64: randomBytes(32).toString('base64'), RATE_LIMIT_HMAC_KEY_BASE64: randomBytes(32).toString('base64'), REDIS_URL: 'redis://:test-only@localhost:6380' };
    const validate = (overrides: object) => environmentSchema.validate({ ...settings, ...overrides }).error;
    expect(validate({})).toBeUndefined();
    expect(validate({ VERIFICATION_CODE_HMAC_KEY_BASE64: settings.JWT_ACCESS_SECRET_BASE64 })).toBeDefined();
    expect(validate({ RATE_LIMIT_HMAC_KEY_BASE64: settings.JWT_ACCESS_SECRET_BASE64 })).toBeDefined();
    expect(validate({ RATE_LIMIT_HMAC_KEY_BASE64: settings.VERIFICATION_CODE_HMAC_KEY_BASE64 })).toBeDefined();
    expect(validate({ NODE_ENV: 'production', RATE_LIMIT_NAMESPACE: 'production' })).toBeDefined();
    expect(validate({ NODE_ENV: 'production', REDIS_URL: 'rediss://:test-only@localhost:6380', RATE_LIMIT_NAMESPACE: 'development' })).toBeDefined();
    expect(validate({ NODE_ENV: 'production', REDIS_URL: 'rediss://:test-only@localhost:6380', RATE_LIMIT_NAMESPACE: 'production' })).toBeUndefined();
  });
});
