import { Controller, Get, HttpException, HttpStatus } from '@nestjs/common';
import { InjectConnection } from '@nestjs/mongoose';
import { ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { Connection } from 'mongoose';

@ApiTags('health')
@Controller('health')
export class HealthController {
  constructor(@InjectConnection() private readonly connection: Connection) {}

  @Get()
  @ApiOperation({ summary: 'Estado de la API y conectividad de MongoDB' })
  @ApiResponse({ status: 200, description: 'API y MongoDB disponibles' })
  @ApiResponse({ status: 503, description: 'MongoDB no disponible' })
  async check(): Promise<{ api: 'up'; mongodb: 'up' }> {
    try {
      if (this.connection.readyState !== 1 || !this.connection.db) throw new Error('Disconnected');
      await this.connection.db.admin().ping();
      return { api: 'up', mongodb: 'up' };
    } catch {
      throw new HttpException({ message: 'MongoDB no disponible', api: 'up', mongodb: 'down' }, HttpStatus.SERVICE_UNAVAILABLE);
    }
  }
}
