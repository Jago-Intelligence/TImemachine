import { createServer } from 'node:http';
import console from 'node:console';
import process from 'node:process';
// Local development receiver. Logs only the event ID, never arbitrary request content.
const server = createServer(async (request, response) => {
  if (request.method !== 'POST' || request.url !== '/alerts') {
    response.writeHead(404).end();
    return;
  }
  let bytes = 0;
  try {
    for await (const chunk of request) {
      bytes += chunk.length;
      if (bytes > 16384) {
        response.writeHead(413).end();
        return;
      }
    }
    const id = request.headers['x-timemachine-event-id'];
    if (
      typeof id !== 'string' ||
      !/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(id)
    ) {
      response.writeHead(400).end();
      return;
    }
    console.log(`Issue alert received: ${id}`);
    response.writeHead(204).end();
  } catch {
    response.writeHead(400).end();
  }
});
server.on('error', () => {
  console.error('Local alert receiver could not start on port 4340.');
  process.exitCode = 1;
});
server.listen(4340, '127.0.0.1', () =>
  console.log('Local alert receiver: http://127.0.0.1:4340/alerts'),
);
for (const signal of ['SIGINT', 'SIGTERM'])
  process.on(signal, () => {
    server.close();
    server.closeAllConnections();
  });
