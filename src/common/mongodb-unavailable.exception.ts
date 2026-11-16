import { HttpException, HttpStatus } from '@nestjs/common';

export class MongoDbUnavailableException extends HttpException {
  constructor() {
    super('MongoDB no disponible', HttpStatus.SERVICE_UNAVAILABLE);
  }
}
