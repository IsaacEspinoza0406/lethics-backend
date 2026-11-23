import { BadRequestException, HttpException, Injectable, ServiceUnavailableException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import { ModuleAccessService } from '../../module-access/application/module-access.service';
import { Flashcard, validFlashcard } from '../domain/flashcards';

/** Student-facing flashcard decks. A deck is visible only when its module is open for the student. */
@Injectable()
export class FlashcardsService {
  constructor(@InjectModel('Flashcard') private readonly cards: Model<Flashcard>, private readonly access: ModuleAccessService) {}

  private async controlled<T>(action: () => Promise<T>): Promise<T> {
    try { return await action(); }
    catch (error) { if (error instanceof HttpException) throw error; throw new ServiceUnavailableException('Flashcards no disponibles.'); }
  }
  private id(value: string): Types.ObjectId {
    if (typeof value !== 'string' || !/^[a-f\d]{24}$/i.test(value)) throw new BadRequestException('Identificador inválido.');
    return new Types.ObjectId(value);
  }

  /** The whole deck of an open module in presentation order; the definition is included so flipping needs no new request. */
  async deck(userId: string, moduleId: string) {
    return this.controlled(async () => {
      const module = await this.access.openModule(userId, this.id(moduleId));
      const found = await this.cards.find({ moduloId: module._id }).sort({ orden: 1, _id: 1 }).lean();
      const items = found.map((card) => {
        if (!validFlashcard(card)) throw new Error('Flashcard incompatible');
        return { id: card._id.toHexString(), orden: card.orden, concepto: card.concepto, definicion: card.definicion };
      });
      return { moduloId: module._id.toHexString(), cursoId: module.cursoId.toHexString(), items };
    });
  }
}
