import pg from 'pg';
import { registrationFixtures } from './registration-app.js';
import {
  defineExpressReplay,
  runExpressReplay,
  createSyntheticPostgres,
  syntheticPostgresFixtureHash,
} from '@timemachine/replay';
import { createDeliveryApp } from './app.js';

await runExpressReplay(
  defineExpressReplay([
    {
      contract: {
        inputMode: 'synthetic-postgres',
        databaseFixtureHash: syntheticPostgresFixtureHash(registrationFixtures),
        service: 'delivery-api',
        profile: 'user-registration-v1',
        scenarioVersion: 'v1',
        method: 'POST',
        route: '/users/register',
        failureCode: 'HTTP_500',
        target: {
          statusCode: 201,
          errorCode: null,
          outcome: 'scenario-assertions-passed',
        },
      },
      async create(recording) {
        if (!recording) throw new Error('Captured synthetic handle required');
        const sandbox = await createSyntheticPostgres(
          registrationFixtures,
          (config) => new pg.Client(config),
        );
        try {
          return {
            handler: createDeliveryApp({ database: sandbox.database }),
            databaseFixtureHash: sandbox.fixtureHash,
            request: { path: '/users/register' },
            async validate({ response }) {
              if (response.status < 500) return true;
              const users = await sandbox.database.query('SELECT id FROM test_users');
              const audit = await sandbox.database.query(
                'SELECT id FROM registration_audit',
              );
              return users.rows.length === 0 && audit.rows.length === 0;
            },
            async assert({ response, body }) {
              const users = await sandbox.database.query(
                'SELECT id, handle FROM test_users',
              );
              const audit = await sandbox.database.query(
                'SELECT user_id, action FROM registration_audit',
              );
              if (response.status >= 500) {
                // Confirm failed transaction left no partial registration behind.
                if (users.rows.length || audit.rows.length)
                  throw new Error('Transaction did not roll back');
                return false;
              }
              return (
                response.status === 201 &&
                users.rows.length === 1 &&
                audit.rows.length === 1 &&
                users.rows[0].handle === recording.request.body.handle &&
                body?.user?.id === users.rows[0].id &&
                body?.user?.handle === recording.request.body.handle &&
                audit.rows[0].user_id === users.rows[0].id &&
                audit.rows[0].action === 'registered'
              );
            },
            close: sandbox.close,
          };
        } catch (error) {
          await sandbox.close();
          throw error;
        }
      },
    },
    {
      contract: {
        inputMode: 'recorded-http',
        service: 'delivery-api',
        profile: 'delivery-quote-v1',
        scenarioVersion: 'v1',
        method: 'POST',
        route: '/delivery/quote',
        failureCode: 'HTTP_500',
        target: {
          statusCode: 200,
          errorCode: null,
          outcome: 'scenario-assertions-passed',
        },
      },
      async create(recording) {
        if (!recording) throw new Error('Captured request required');
        return {
          handler: createDeliveryApp(),
          request: { path: '/delivery/quote' },
          assert: ({ response, body }) =>
            response.status === 200 &&
            body?.quote?.distanceKm === recording.request.body.distanceKm &&
            body?.quote?.ratePerKm === 2 &&
            body?.quote?.currency === 'USD' &&
            body?.quote?.fee ===
              Math.round(recording.request.body.distanceKm * 2 * 100) / 100,
        };
      },
    },
    {
      contract: {
        inputMode: 'recorded-http',
        service: 'delivery-api',
        profile: 'delivery-zone-quote-v1',
        scenarioVersion: 'v1',
        method: 'POST',
        route: '/delivery/zone-quote',
        failureCode: 'HTTP_500',
        target: {
          statusCode: 200,
          errorCode: null,
          outcome: 'scenario-assertions-passed',
        },
      },
      async create(recording, dependencies) {
        if (!recording || !dependencies) throw new Error('Database recording required');
        const rate = recording.request.body.zoneCode === 'EXPRESS' ? 4 : 2;
        return {
          handler: createDeliveryApp({ database: dependencies.postgres }),
          request: { path: '/delivery/zone-quote' },
          assert: ({ response, body }) =>
            response.status === 200 &&
            body?.quote?.distanceKm === recording.request.body.distanceKm &&
            body?.quote?.zoneCode === recording.request.body.zoneCode &&
            body?.quote?.currency === 'USD' &&
            body?.quote?.ratePerKm === rate &&
            body?.quote?.fee ===
              Math.round(recording.request.body.distanceKm * rate * 100) / 100,
        };
      },
    },
  ]),
);
