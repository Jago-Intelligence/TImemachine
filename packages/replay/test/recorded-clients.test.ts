import { createHash } from 'node:crypto';
import { expect, it } from 'vitest';
import { operationSelector, type OperationRecording } from '@timemachine/core';
import {
  createRecordedClients,
  createRecordedAxiosAdapter,
} from '../src/recorded-clients.js';
function fixture(
  kind: OperationRecording['kind'],
  operation: OperationRecording['operation'],
  selector: string,
  input: OperationRecording['input'],
  rows: OperationRecording['rows'],
): OperationRecording {
  return {
    id: 'test',
    kind,
    operation,
    selectorHash: createHash('sha256')
      .update(`${kind}:${operation}:${operationSelector(kind, operation, selector)}`)
      .digest('hex'),
    input,
    rows,
    partial: false,
    result: 'rows',
  };
}
it('replays approved database reads and job acknowledgments without live clients', async () => {
  const sql = 'SELECT price FROM products WHERE sku = ? AND region = ?';
  const mysql = {
    ...fixture('mysql', 'execute', sql, { region: 'UK', sku: 'MUG' }, [{ price: 2 }]),
    inputOrder: ['sku', 'region'],
    fields: ['price'],
  };
  const mongo = {
    ...fixture('mongodb', 'findOne', 'products', { sku: 'MUG' }, [{ stock: 4 }]),
    fields: ['stock'],
  };
  const queue = fixture('bullmq', 'add', 'tasks/notify', { sku: 'MUG' }, [
    { jobId: '42' },
  ]);
  const clients = createRecordedClients([mysql, mongo, queue]);
  expect(await clients.mysql.execute(sql, ['MUG', 'UK'])).toEqual([
    [{ price: 2 }],
    [{ name: 'price' }],
  ]);
  expect(
    await clients.mongodb
      .collection('products')
      .findOne({ sku: 'MUG' }, { projection: { stock: 1, _id: 0 } }),
  ).toEqual({ stock: 4 });
  expect(await clients.queues.queue('tasks').add('notify', { sku: 'MUG' })).toMatchObject(
    { id: '42' },
  );
  expect(clients.queues.submittedJobs()).toHaveLength(1);
  expect(() => clients.assertComplete()).not.toThrow();
});
it('rejects changed, incomplete, unused and extra calls even if the app catches errors', async () => {
  const sql = 'SELECT price FROM products WHERE sku = ?';
  const row = fixture('mysql', 'query', sql, { sku: 'MUG' }, [{ price: 2 }]);
  const unused = createRecordedClients([row]);
  expect(() => unused.assertComplete()).toThrow();
  const changed = createRecordedClients([row]);
  await expect(changed.mysql.query(sql, ['OTHER'])).rejects.toThrow();
  expect(() => changed.assertComplete()).toThrow();
  const partial = createRecordedClients([{ ...row, partial: true }]);
  await expect(partial.mysql.query(sql, ['MUG'])).rejects.toThrow();
  const extra = createRecordedClients([]);
  await expect(extra.mysql.query('DELETE FROM products')).rejects.toThrow();
  expect(() => extra.assertComplete()).toThrow();
});
it('rejects changed MongoDB projections and queue scheduling options', async () => {
  const clients = createRecordedClients([
    {
      ...fixture('mongodb', 'findOne', 'products', { sku: 'MUG' }, []),
      fields: ['stock'],
    },
    fixture('bullmq', 'add', 'tasks/notify', { sku: 'MUG' }, [{ jobId: '42' }]),
  ]);
  await expect(
    clients.mongodb
      .collection('products')
      .findOne({ sku: 'MUG' }, { projection: { stock: 1 } }),
  ).rejects.toThrow();
  await expect(
    clients.queues.queue('tasks').add('notify', { sku: 'MUG' }, { delay: 100 }),
  ).rejects.toThrow();
  expect(() => clients.assertComplete()).toThrow();
});
it('uses only fixture HTTP transport for Axios and preserves HTTP error shape', async () => {
  const adapter = createRecordedAxiosAdapter(
    async () => new Response('{"code":"UNAVAILABLE"}', { status: 503 }),
  );
  await expect(adapter({ url: 'https://pricing.example/rates' })).rejects.toMatchObject({
    isAxiosError: true,
    response: { status: 503, data: '{"code":"UNAVAILABLE"}' },
  });
});
