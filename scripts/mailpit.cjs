// Owns only a UUID Compose project, temporary certificates and test process environment.
const { spawnSync, spawn } = require('node:child_process');
const { mkdtempSync, readFileSync, existsSync, rmSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join, resolve, dirname, relative, isAbsolute } = require('node:path');
const { randomUUID } = require('node:crypto');
const { createServer } = require('node:net');

const root = resolve(__dirname, '..');
const mode = process.argv[2];
if (!['test', 'suite', 'serve'].includes(mode)) throw new Error('Uso: node scripts/mailpit.cjs test|suite|serve');
const project = `lethics-mailpit-${randomUUID()}`;
const certDir = mkdtempSync(join(tmpdir(), 'lethics-mailpit-'));
const composeArgs = ['compose', '--env-file', join(certDir, 'compose.env'), '-p', project, '-f', join(root, 'compose.mailpit.yaml')];
require('node:fs').writeFileSync(join(certDir, 'compose.env'), ''); // Never interpolate private .env into Compose.
let started = false;
let child;

function command(executable, args, env, quiet = false) {
  const result = spawnSync(executable, args, { cwd: root, env, stdio: quiet ? 'pipe' : 'inherit', timeout: 180000 });
  if (result.error || result.status !== 0) {
    if (quiet) console.error(result.error?.message || result.stderr?.toString());
    throw new Error(`Falló ${executable}: ${args[0]}`);
  }
}
async function port(preferred) {
  const reserve = (value) => new Promise((accept, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(value, '127.0.0.1', () => {
      const selected = server.address().port;
      server.close((error) => error ? reject(error) : accept(selected));
    });
  });
  try { return await reserve(preferred); }
  catch { const selected = await reserve(0); console.log(`Puerto ${preferred} ocupado; se usará ${selected}.`); return selected; }
}
async function main() {
  const smtpPort = await port(1025), httpPort = await port(8025);
  const openssl = process.env.OPENSSL_BIN || (existsSync('C:/msys64/ucrt64/bin/openssl.exe') ? 'C:/msys64/ucrt64/bin/openssl.exe' : 'openssl');
  require('node:fs').writeFileSync(join(certDir, 'openssl.cnf'), '[req]\ndistinguished_name=dn\n[dn]\n');
  command(openssl, ['req', '-config', join(certDir, 'openssl.cnf'), '-x509', '-newkey', 'rsa:2048', '-sha256', '-nodes', '-days', '2', '-subj', '/CN=localhost', '-addext', 'subjectAltName=DNS:localhost,IP:127.0.0.1', '-addext', 'basicConstraints=critical,CA:TRUE', '-keyout', join(certDir, 'key.pem'), '-out', join(certDir, 'cert.pem')], process.env, true);
  const env = { ...process.env, LETHICS_MAILPIT_SMTP_PORT: String(smtpPort), LETHICS_MAILPIT_HTTP_PORT: String(httpPort), LETHICS_MAILPIT_CERT_DIR: certDir.replace(/\\/g, '/') };
  started = true; // Cleanup even after a partially failed up.
  command('docker', [...composeArgs, 'up', '-d'], env);
  const api = `http://127.0.0.1:${httpPort}`;
  let ready = false;
  for (let attempt = 0; attempt < 50; attempt++) {
    try { if ((await fetch(`${api}/api/v1/messages`, { signal: AbortSignal.timeout(1000) })).ok) { ready = true; break; } } catch { /* bounded startup wait */ }
    await new Promise((done) => setTimeout(done, 200));
  }
  if (!ready) {
    command('docker', [...composeArgs, 'logs', '--tail', '20', 'mailpit'], env);
    throw new Error('Mailpit no está disponible');
  }
  console.log(`Mailpit: ${api} | SMTP STARTTLS localhost:${smtpPort} | proyecto ${project}`);
  if (mode === 'serve') {
    console.log(`NODE_EXTRA_CA_CERTS=${join(certDir, 'cert.pem')}\nSMTP_HOST=localhost\nSMTP_PORT=${smtpPort}\nSMTP_SECURE=false\nSMTP_USER=mailpit\nSMTP_PASSWORD=mailpit-local-only\nSMTP_FROM=verificacion@example.test\nVERIFICATION_MAIL_TRANSPORT=smtp`);
    console.log('Captura local sin relay. Ctrl+C detiene y limpia este proyecto.');
    await new Promise((done) => { process.once('SIGINT', done); process.once('SIGTERM', done); });
    return;
  }
  const privateEnv = existsSync(join(root, '.env')) ? require('dotenv').parse(readFileSync(join(root, '.env'))) : {};
  // Derive only an admin seed; the shared helper rejects lethics and owns a fresh UUID database.
  let mongo = process.env.LETHICS_IDENTITY_TEST_URI;
  if (!mongo && privateEnv.MONGODB_URI) { const seed = new URL(privateEnv.MONGODB_URI); seed.pathname = '/admin'; mongo = seed.toString(); }
  const redis = process.env.LETHICS_REDIS_TEST_URL || privateEnv.REDIS_URL;
  if (!mongo || !redis) throw new Error('Faltan conexiones locales para integración aislada');
  const testEnv = { ...env, NODE_EXTRA_CA_CERTS: join(certDir, 'cert.pem'), LETHICS_MAILPIT_API_URL: api, LETHICS_IDENTITY_TEST_URI: mongo, LETHICS_REDIS_TEST_URL: redis };
  const jest = join(root, 'node_modules/jest/bin/jest.js');
  const args = mode === 'suite'
    ? [join(dirname(process.execPath), 'node_modules/npm/bin/npm-cli.js'), 'test', '--', '--detectOpenHandles']
    : [jest, '--runInBand', '--runTestsByPath', 'test/smtp-verification.spec.ts', 'test/smtp-delivery-policy.spec.ts', 'test/mailpit.integration.spec.ts', 'test/auth-http.integration.spec.ts', '--detectOpenHandles'];
  const result = await new Promise((done) => {
    child = spawn(process.execPath, args, { cwd: root, env: testEnv, stdio: 'inherit' });
    child.once('error', () => done(1)); child.once('exit', (code) => done(code === null ? 1 : code));
  });
  child = undefined;
  process.exitCode = result;
}
main().catch((error) => { console.error(error.message.startsWith('Falló ') ? error.message : 'No se pudo completar el entorno Mailpit aislado.'); process.exitCode = 1; }).finally(() => {
  try {
    if (child) child.kill();
    if (started) command('docker', [...composeArgs, 'down'], { ...process.env, LETHICS_MAILPIT_SMTP_PORT: '1025', LETHICS_MAILPIT_HTTP_PORT: '8025', LETHICS_MAILPIT_CERT_DIR: certDir.replace(/\\/g, '/') });
    // This path is the exact directory returned by mkdtempSync, never an operator-supplied path.
    const ownedPath = relative(resolve(tmpdir()), resolve(certDir));
    if (isAbsolute(ownedPath) || ownedPath.startsWith('..') || !/^lethics-mailpit-[^/\\]+$/.test(ownedPath)) throw new Error('Ruta temporal fuera del directorio autorizado');
    rmSync(certDir, { recursive: true });
    console.log('Recursos Mailpit y certificados temporales eliminados.');
  } catch { console.error(`Limpieza Mailpit incompleta: proyecto ${project}, directorio ${certDir}`); process.exitCode = 1; }
});
