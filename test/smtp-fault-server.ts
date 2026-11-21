import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { createServer } from 'node:tls';
import { Socket } from 'node:net';

export type SmtpFault = 'temporary' | 'permanent' | 'disconnect-after-data' | 'timeout-after-data';

/** Minimal local TLS receiver: no relay or delivery. Certificates belong to the Mailpit runner. */
export async function createFaultSmtpServer(fault: SmtpFault) {
  const certPath = process.env.NODE_EXTRA_CA_CERTS;
  if (!process.env.LETHICS_MAILPIT_API_URL || !certPath) throw new Error('Fixture SMTP requiere entorno Mailpit explícito');
  const sockets = new Set<Socket>();
  const messages: string[] = [];
  let connections = 0, mailCommands = 0;
  const server = createServer({ cert: readFileSync(certPath), key: readFileSync(join(dirname(certPath), 'key.pem')), minVersion: 'TLSv1.2' }, (socket) => {
    connections++;
    let buffer = '', data = false;
    socket.setEncoding('utf8');
    socket.on('error', () => { /* Deliberate peer disconnect; never log message content. */ });
    socket.write('220 localhost ESMTP synthetic test\r\n');
    socket.on('data', (chunk: string) => {
      buffer += chunk;
      while (buffer) {
        if (data) {
          const end = buffer.indexOf('\r\n.\r\n');
          if (end < 0) return;
          messages.push(buffer.slice(0, end));
          buffer = buffer.slice(end + 5); data = false;
          if (fault === 'disconnect-after-data') { socket.destroy(); return; }
          if (fault === 'timeout-after-data') return; // No final 250: the client must time out without retrying.
          socket.write('250 2.0.0 Captured locally\r\n');
          continue;
        }
        const end = buffer.indexOf('\r\n');
        if (end < 0) return;
        const command = buffer.slice(0, end).toUpperCase(); buffer = buffer.slice(end + 2);
        if (command.startsWith('EHLO')) socket.write('250-localhost\r\n250 AUTH PLAIN\r\n');
        else if (command.startsWith('AUTH PLAIN')) socket.write('235 2.7.0 Authenticated\r\n');
        else if (command.startsWith('MAIL FROM:')) {
          mailCommands++;
          socket.write(fault === 'temporary' && mailCommands === 1 ? '451 4.3.0 Synthetic temporary rejection\r\n' : '250 2.1.0 Sender accepted\r\n');
        } else if (command.startsWith('RCPT TO:')) socket.write(fault === 'permanent' ? '550 5.1.1 Synthetic recipient rejection\r\n' : '250 2.1.5 Recipient accepted\r\n');
        else if (command === 'DATA') { data = true; socket.write('354 Send message\r\n'); }
        else if (command === 'QUIT') socket.end('221 Goodbye\r\n');
        else if (command === 'RSET') socket.write('250 Reset\r\n');
        else socket.write('500 Unsupported synthetic command\r\n');
      }
    });
  });
  server.on('connection', (socket) => { sockets.add(socket); socket.once('close', () => sockets.delete(socket)); });
  server.on('tlsClientError', () => { /* Intentional failures remain local. */ });
  await new Promise<void>((accept, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', accept); });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Puerto TLS no disponible');
  return { port: address.port, messages, get connections() { return connections; },
    async close() {
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((accept, reject) => server.close((error) => error ? reject(error) : accept()));
    },
  };
}
