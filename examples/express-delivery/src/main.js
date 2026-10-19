import pg from 'pg';
import process from 'node:process';
import { createDeliveryApp, createPricingApp } from './app.js';

const database = process.env.DELIVERY_DATABASE_URL
  ? new pg.Pool({
      connectionString: process.env.DELIVERY_DATABASE_URL,
      max: 2,
      ssl: false,
      connectionTimeoutMillis: 3000,
      allowExitOnIdle: true,
    })
  : undefined;
database?.on('error', () => {
  process.stderr.write('Delivery database connection unavailable.\n');
});
if (database) {
  await database.query(
    'CREATE TABLE IF NOT EXISTS test_users (id SERIAL PRIMARY KEY, handle TEXT NOT NULL UNIQUE)',
  );
  await database.query(
    'CREATE TABLE IF NOT EXISTS registration_audit (id SERIAL PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES test_users(id), action TEXT NOT NULL)',
  );
}
const pricing = createPricingApp();
const servers = [];
function started(server) {
  server.on('error', () => {
    process.stderr.write(
      'Delivery demo port unavailable. Stop existing processes on 4322/4330.\n',
    );
    for (const running of servers) running.close();
    process.exitCode = 1;
  });
  servers.push(server);
}
started(pricing.listen(4330, '127.0.0.1'));
started(
  createDeliveryApp({ dashboardOrigin: process.env.DASHBOARD_ORIGIN, database }).listen(
    4322,
    '127.0.0.1',
    () => {
      process.stdout.write('Delivery test page: http://127.0.0.1:4322\n');
    },
  ),
);
let stopping = false;
for (const signal of ['SIGINT', 'SIGTERM'])
  process.on(signal, () => {
    if (stopping) return;
    stopping = true;
    void database?.end();
    for (const server of servers) {
      server.close();
      server.closeIdleConnections();
    }
  });
