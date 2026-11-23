import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { AccessControlModule } from '../auth/access-control.module';
import { ModuleAccessModule } from '../module-access/module-access.module';
import { FlashcardsService } from './application/flashcards.service';
import { FlashcardSchema } from './infrastructure/flashcard.schema';
import { FlashcardsController } from './presentation/flashcards.controller';

/** Flashcard decks per module. Independent of the lessons module: both only share the module-access rule. */
@Module({
  imports: [AccessControlModule, ModuleAccessModule, MongooseModule.forFeature([{ name: 'Flashcard', schema: FlashcardSchema }])],
  controllers: [FlashcardsController],
  providers: [FlashcardsService],
})
export class FlashcardsModule {}
