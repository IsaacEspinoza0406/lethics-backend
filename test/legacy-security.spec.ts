import { Db } from 'mongodb';
import { Types } from 'mongoose';
import { inspectLegacySecurity } from '../src/modules/identity/infrastructure/legacy-security';

describe('Inventario heredado de solo lectura', () => {
  const state = { tokenActualId: new Types.ObjectId(), ultimaEmision: new Date(), emisionesInicio: new Date(), fallosInicio: new Date(), emisiones: 5, fallos: 20, revision: 0 };
  it.each([
    [{ verificadoEn: new Date() }, 0],
    [{ verificadoEn: new Date(), seguridadVerificacion: { fallos: 20 } }, 0],
    [{ verificadoEn: null }, 1],
    [{}, 1],
    [{ verificadoEn: null, seguridadVerificacion: { revision: 0 } }, 1],
    [{ verificadoEn: new Date(NaN) }, 1],
    [{ verificadoEn: '2026-11-21' }, 1],
    [{ verificadoEn: null, seguridadVerificacion: state }, 0],
  ])('clasifica la cuenta %j sin modificarla', async (user, blockedUsers) => {
    const before = JSON.stringify(user);
    const users = { find: jest.fn(() => [user]) };
    const tokens = { find: jest.fn(() => []) };
    const db = { collection: jest.fn((name: string) => name === 'usuarios' ? users : tokens) } as unknown as Db;
    expect(await inspectLegacySecurity(db)).toEqual({ blockedUsers, unsafeActiveTokens: 0 });
    expect(JSON.stringify(user)).toBe(before);
    expect(users.find).toHaveBeenCalledWith({}, { projection: { seguridadVerificacion: 1, verificadoEn: 1 } });
  });
});
