import { model, Types } from 'mongoose';
import { SesionSchema, TokenCuentaSchema, UsuarioSchema } from '../src/modules/identity/infrastructure/schemas/identity.schemas';

const Usuario = model('IdentityUnitUsuario', UsuarioSchema);
const Token = model('IdentityUnitToken', TokenCuentaSchema);
const Sesion = model('IdentityUnitSesion', SesionSchema);

describe('Esquemas de identidad', () => {
  const id = new Types.ObjectId();
  const fecha = new Date('2026-01-01T00:00:00Z');
  const usuario = { nombre: 'Nombre', correo: 'test@example.invalid', contraseñaHash: 'hash', rol: 'rol' };
  const token = { usuarioId: id, tipo: 'verificacion', tokenHash: 'hash', expiraEn: fecha };
  const sesion = { usuarioId: id, refreshTokenHash: 'hash', expiraEn: fecha };
  it.each([
    [Usuario, usuario, ['nombre', 'correo', 'contraseñaHash', 'rol']],
    [Token, token, ['usuarioId', 'tipo', 'tokenHash', 'expiraEn']],
    [Sesion, sesion, ['usuarioId', 'refreshTokenHash', 'expiraEn']],
  ])('rechaza campos esenciales ausentes y nulos', (Modelo, datos, campos) => {
    for (const campo of campos as string[]) {
      expect(new Modelo({ ...datos, [campo]: undefined }).validateSync()?.errors[campo]).toBeDefined();
      expect(new Modelo({ ...datos, [campo]: null }).validateSync()?.errors[campo]).toBeDefined();
    }
    expect(new Modelo(datos).validateSync()).toBeUndefined();
  });
  it('valida los campos de unicidad y normaliza el correo', () => {
    expect(new Usuario({}).validateSync()?.errors.correo).toBeDefined();
    expect(new Token({}).validateSync()?.errors.tokenHash).toBeDefined();
    expect(new Usuario({ correo: '  TEST@EXAMPLE.INVALID ' }).correo).toBe('test@example.invalid');
    for (const correo of ['invalido', 'a@@b.com', ' ', 'a b@example.com']) {
      expect(new Usuario({ ...usuario, correo }).validateSync()?.errors.correo).toBeDefined();
    }
    expect(new Usuario({ ...usuario, contraseñaHash: '   ' }).validateSync()?.errors.contraseñaHash).toBeDefined();
  });
  it('valida el tipo documentado y los ObjectId y Date', () => {
    expect(new Token({ tokenHash: 'x', tipo: 'otro', usuarioId: 'incorrecto', expiraEn: 'fecha incorrecta' }).validateSync()?.errors).toMatchObject({ tipo: expect.anything(), usuarioId: expect.anything(), expiraEn: expect.anything() });
    const doc = new Sesion({ ...sesion, creadaEn: new Date('2026-01-01T00:00:00Z'), revocadaEn: null });
    expect(doc.validateSync()).toBeUndefined();
    expect(doc.usuarioId).toBeInstanceOf(Types.ObjectId);
    expect(doc.creadaEn).toBeInstanceOf(Date);
    expect(doc.revocadaEn).toBeNull();
  });
  it.each([
    [new Usuario({ correo: 'test@example.invalid', contraseñaHash: 'secreto' }), 'contraseñaHash'],
    [new Token({ tokenHash: 'secreto' }), 'tokenHash'],
    [new Sesion({ refreshTokenHash: 'secreto' }), 'refreshTokenHash'],
  ])('omite el hash al serializar documentos', (doc, field) => {
    expect(doc.toObject()).not.toHaveProperty(field as string);
    expect(JSON.parse(JSON.stringify(doc))).not.toHaveProperty(field as string);
  });
});
