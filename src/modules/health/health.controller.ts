import { Controller, Get } from '@nestjs/common';
import { InjectConnection } from '@nestjs/mongoose';
import { ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { Connection } from 'mongoose';
import { MongoDbUnavailableException } from '../../common/mongodb-unavailable.exception';
import { Public } from '../auth/access-control';

@ApiTags('health')
@Controller('health')
@Public()
export class HealthController {
  constructor(@InjectConnection() private readonly connection: Connection) {}

  @Get()
  @ApiOperation({ summary: 'Estado de la API y conectividad de MongoDB' })
  @ApiResponse({ status: 200, description: 'API y MongoDB disponibles', schema: { example: { api: 'up', mongodb: 'up' } } })
  @ApiResponse({ status: 503, description: 'MongoDB no disponible', schema: { example: { statusCode: 503, message: 'MongoDB no disponible', api: 'up', mongodb: 'down', path: '/api/v1/health', timestamp: '2026-01-01T00:00:00.000Z' } } })
  async check(): Promise<{ api: 'up'; mongodb: 'up' }> {
    try {
      if (this.connection.readyState !== 1 || !this.connection.db) throw new Error('Disconnected');
      await this.connection.db.admin().ping();
      return { api: 'up', mongodb: 'up' };
    } catch {
      throw new MongoDbUnavailableException();
    }
  }
}
