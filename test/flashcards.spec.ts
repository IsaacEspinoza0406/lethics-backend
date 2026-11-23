import { BadRequestException, ForbiddenException, NotFoundException, ServiceUnavailableException } from '@nestjs/common';
import { Model, Types } from 'mongoose';
import { FlashcardsService } from '../src/modules/flashcards/application/flashcards.service';
import { Flashcard, MAX_CONCEPT_LENGTH, MAX_DEFINITION_LENGTH, validFlashcard } from '../src/modules/flashcards/domain/flashcards';
import { ModuleAccessService } from '../src/modules/module-access/application/module-access.service';
import { cardFixture } from './flashcards-fixtures';
import { courseFixture, moduleFixture } from './learning-fixtures';

describe('Dominio de flashcards', () => {
  const moduloId = new Types.ObjectId();
  it('acepta una tarjeta completa y respeta los límites de texto', () => {
    expect(validFlashcard(cardFixture(moduloId, 1))).toBe(true);
    expect(validFlashcard(cardFixture(moduloId, 1, { concepto: 'x'.repeat(MAX_CONCEPT_LENGTH), definicion: 'y'.repeat(MAX_DEFINITION_LENGTH) }))).toBe(true);
  });
  it.each([
    ['concepto vacío', { concepto: '  ' }],
    ['definición vacía', { definicion: '' }],
    ['concepto demasiado largo', { concepto: 'x'.repeat(MAX_CONCEPT_LENGTH + 1) }],
    ['definición demasiado larga', { definicion: 'y'.repeat(MAX_DEFINITION_LENGTH + 1) }],
    ['orden cero', { orden: 0 }],
    ['orden decimal', { orden: 1.5 }],
    ['orden como texto', { orden: '1' as unknown as number }],
    ['moduloId sin ObjectId', { moduloId: moduloId.toHexString() as unknown as Types.ObjectId }],
  ])('rechaza tarjeta inválida: %s', (_name, overrides) => expect(validFlashcard(cardFixture(moduloId, 1, overrides))).toBe(false));
  it('rechaza valores que no son objetos o que carecen de _id', () => {
    for (const value of [null, undefined, 'tarjeta', 7, [], { ...cardFixture(moduloId, 1), _id: undefined }]) expect(validFlashcard(value)).toBe(false);
  });
});

describe('FlashcardsService', () => {
  const course = courseFixture(), module = moduleFixture(course._id, 1), user = new Types.ObjectId().toHexString();
  const sort = jest.fn(), find = jest.fn(), lean = jest.fn();
  const access = { openModule: jest.fn() };
  const service = () => new FlashcardsService({ find } as unknown as Model<Flashcard>, access as unknown as ModuleAccessService);
  beforeEach(() => {
    jest.resetAllMocks();
    find.mockReturnValue({ sort }); sort.mockReturnValue({ lean });
    access.openModule.mockResolvedValue(module);
    lean.mockResolvedValue([cardFixture(module._id, 1), cardFixture(module._id, 2)]);
  });

  it('devuelve el mazo con concepto y definición, ordenado, para un módulo abierto', async () => {
    const cards = [cardFixture(module._id, 1), cardFixture(module._id, 2)]; lean.mockResolvedValue(cards);
    expect(await service().deck(user, module._id.toHexString())).toEqual({ moduloId: module._id.toHexString(), cursoId: course._id.toHexString(),
      items: cards.map((c) => ({ id: c._id.toHexString(), orden: c.orden, concepto: c.concepto, definicion: c.definicion })) });
    expect(access.openModule).toHaveBeenCalledWith(user, module._id);
    expect(find).toHaveBeenCalledWith({ moduloId: module._id }); expect(sort).toHaveBeenCalledWith({ orden: 1, _id: 1 });
  });
  it('un módulo sin tarjetas devuelve un mazo vacío', async () => {
    lean.mockResolvedValue([]);
    expect((await service().deck(user, module._id.toHexString())).items).toEqual([]);
  });
  it('un módulo no disponible o bloqueado no consulta las tarjetas', async () => {
    access.openModule.mockRejectedValue(new NotFoundException('Módulo no disponible.'));
    await expect(service().deck(user, module._id.toHexString())).rejects.toBeInstanceOf(NotFoundException);
    access.openModule.mockRejectedValue(new ForbiddenException('bloqueado'));
    await expect(service().deck(user, module._id.toHexString())).rejects.toBeInstanceOf(ForbiddenException);
    expect(find).not.toHaveBeenCalled();
  });
  it('rechaza identificadores inválidos antes de consultar', async () => {
    await expect(service().deck(user, '123')).rejects.toBeInstanceOf(BadRequestException);
    expect(access.openModule).not.toHaveBeenCalled();
  });
  it('una tarjeta incompatible produce 503 y no se expone ninguna', async () => {
    lean.mockResolvedValue([cardFixture(module._id, 1), cardFixture(module._id, 2, { definicion: '' })]);
    await expect(service().deck(user, module._id.toHexString())).rejects.toBeInstanceOf(ServiceUnavailableException);
  });
  it('un fallo de almacenamiento o de progreso produce 503 sanitizado', async () => {
    lean.mockRejectedValue(new Error('mongodb://secreto'));
    const storage = await service().deck(user, module._id.toHexString()).catch((e: unknown) => e);
    expect(storage).toBeInstanceOf(ServiceUnavailableException);
    expect(JSON.stringify((storage as ServiceUnavailableException).getResponse())).not.toMatch(/mongodb|secreto/);
    access.openModule.mockRejectedValue(new Error('progreso caído'));
    await expect(service().deck(user, module._id.toHexString())).rejects.toBeInstanceOf(ServiceUnavailableException);
  });
});
