/** Read-only assessment. Clean shutdown/AOF recovery alone never bypass quarantine. */
export function inspectRedisReadiness(server: string, persistence: string, replication: string, settings: unknown, maxWindow: number) {
  const runId = /^run_id:([a-f0-9]{40})\r?$/m.exec(server)?.[1];
  const uptimeText = /^uptime_in_seconds:(\d+)\r?$/m.exec(server)?.[1];
  const uptime = uptimeText === undefined ? NaN : Number(uptimeText);
  const values = new Map<string, unknown>();
  if (Array.isArray(settings) && settings.length === 6) {
    for (let i = 0; i < settings.length; i += 2) values.set(String(settings[i]), settings[i + 1]);
  } else if (settings && typeof settings === 'object' && !Array.isArray(settings)) {
    for (const [key, value] of Object.entries(settings)) values.set(key, value);
  }
  const trusted = !!runId && Number.isSafeInteger(uptime) && Number.isSafeInteger(maxWindow) && maxWindow > 0 &&
    /^loading:0\r?$/m.test(persistence) && /^aof_enabled:1\r?$/m.test(persistence) &&
    /^aof_last_write_status:ok\r?$/m.test(persistence) && /^aof_last_bgrewrite_status:ok\r?$/m.test(persistence) &&
    /^role:master\r?$/m.test(replication) && values.get('appendonly') === 'yes' &&
    values.get('appendfsync') === 'always' && values.get('maxmemory-policy') === 'noeviction';
  const quarantineRemainingSeconds = trusted ? Math.max(0, maxWindow - uptime) : null;
  return { ready: trusted && quarantineRemainingSeconds === 0, reason: !trusted ? 'uncertain' : quarantineRemainingSeconds ? 'quarantine' : 'ready', quarantineRemainingSeconds, runId };
}
