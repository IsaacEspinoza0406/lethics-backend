import { inspectRedisReadiness } from '../src/infrastructure/rate-limit/redis-readiness';

describe('Recuperación conservadora de Redis', () => {
  const server = `run_id:${'a'.repeat(40)}\r\nuptime_in_seconds:3600\r\n`;
  const persistence = 'loading:0\r\naof_enabled:1\r\naof_last_write_status:ok\r\naof_last_bgrewrite_status:ok\r\n';
  const replication = 'role:master\r\n';
  const settings = ['appendonly', 'yes', 'appendfsync', 'always', 'maxmemory-policy', 'noeviction'];
  it('exige toda la ventana incluso con AOF sano y distingue cuarentena de incertidumbre', () => {
    expect(inspectRedisReadiness(server, persistence, replication, settings, 3600).ready).toBe(true);
    expect(inspectRedisReadiness(server.replace('3600', '3599'), persistence, replication, settings, 3600)).toMatchObject({ ready: false, reason: 'quarantine', quarantineRemainingSeconds: 1 });
    expect(inspectRedisReadiness(server.replace('3600', '0'), persistence, replication, settings, 3600)).toMatchObject({ ready: false, quarantineRemainingSeconds: 3600 });
  });
  it.each([
    ['loading:0', 'loading:1'], ['aof_enabled:1', 'aof_enabled:0'],
    ['aof_last_write_status:ok', 'aof_last_write_status:err'], ['aof_last_bgrewrite_status:ok', 'aof_last_bgrewrite_status:err'],
  ])('falla cerrado ante %s inválido', (from, to) => {
    expect(inspectRedisReadiness(server, persistence.replace(from, to), replication, settings, 3600)).toMatchObject({ ready: false, reason: 'uncertain' });
  });
  it('rechaza réplica, CONFIG denegado, expulsión y respuesta incompleta', () => {
    expect(inspectRedisReadiness(server, persistence, 'role:slave\r\n', settings, 3600).ready).toBe(false);
    expect(inspectRedisReadiness(server, persistence, replication, null, 3600).ready).toBe(false);
    expect(inspectRedisReadiness(server, persistence, replication, settings.map((v) => v === 'noeviction' ? 'allkeys-lru' : v), 3600).ready).toBe(false);
    expect(inspectRedisReadiness('', persistence, replication, settings, 3600).ready).toBe(false);
  });
});
