import { Module } from '@nestjs/common';
import { OriginRateLimitService } from './origin-rate-limit.service';

@Module({ providers: [OriginRateLimitService], exports: [OriginRateLimitService] })
export class RateLimitModule {}
