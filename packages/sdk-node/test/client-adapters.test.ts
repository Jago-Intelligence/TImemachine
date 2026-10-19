import { expect, it, vi } from 'vitest';
import type { OperationRule } from '@timemachine/core';
import { createClientAdapters, type OperationScope } from '../src/client-adapters.js';
const rules: OperationRule[] = [
  {
    id: 'price',
    kind: 'mysql',
    operation: 'execute',
    selector: 'SELECT price FROM products WHERE sku = ?',
    inputFields: ['sku'],
    resultFields: ['price'],
  },
  {
    id: 'stock',
    kind: 'mongodb',
    operation: 'findOne',
    selector: 'products',
    inputFields: ['sku'],
    resultFields: ['stock'],
  },
  {
    id: 'notify',
    kind: 'bullmq',
    operation: 'add',
    selector: 'tasks/notify',
    inputFields: ['sku'],
    resultFields: ['jobId'],
  },
];
function setup() {
  const promises: Promise<void>[] = [];
  const state: OperationScope = {
    body: { sku: 'MUG' },
    ended: false,
    records: [],
    truncate: vi.fn(),
    pending: (promise) => promises.push(promise),
    timeline: vi.fn(),
  };
  return {
    state,
    clients: createClientAdapters(() => state, rules),
    settle: () => Promise.all(promises),
  };
}
it('records approved mysql, MongoDB and BullMQ results while preserving original result objects', async () => {
  const { state, clients, settle } = setup();
  const mysqlResult = [[{ price: 2 }], [{ name: 'price' }]];
  expect(
    await clients
      .mysql({ execute: async (...args: unknown[]) => (void args, mysqlResult) })
      .execute(rules[0]!.selector, ['MUG']),
  ).toBe(mysqlResult);
  const document = { stock: 4 };
  expect(
    await clients
      .mongodb(
        { findOne: async (...args: unknown[]) => (void args, document) },
        'products',
      )
      .findOne({ sku: 'MUG' }, { projection: { _id: 0, stock: 1 } }),
  ).toBe(document);
  const job = { id: '42', data: { sku: 'MUG' }, private: 'not retained' };
  expect(
    await clients
      .bullmq({ add: async (...args: unknown[]) => (void args, job) }, 'tasks')
      .add('notify', { sku: 'MUG' }),
  ).toBe(job);
  await settle();
  expect(state.records.map((row) => [row.kind, row.partial, row.result])).toEqual([
    ['mysql', false, 'rows'],
    ['mongodb', false, 'rows'],
    ['bullmq', false, 'rows'],
  ]);
  expect(state.records[1]?.fields).toEqual(['stock']);
  expect(JSON.stringify(state.records)).not.toMatch(
    /not retained|SELECT|products|private/,
  );
});
it('omits unbound parameters and redacted columns and preserves original errors', async () => {
  const { state, clients } = setup();
  const mysql = clients.mysql({
    execute: async (...args: unknown[]) => (
      void args,
      [[{ price: 2, password: 'private' }], [{ name: 'price' }, { name: 'password' }]]
    ),
  });
  await mysql.execute(rules[0]!.selector, ['SECRET']);
  expect(state.records[0]).toMatchObject({ input: {}, rows: [], partial: true });
  await mysql.execute(rules[0]!.selector, ['MUG']);
  expect(state.records[1]).toMatchObject({ rows: [], partial: true });
  expect(JSON.stringify(state.records)).not.toContain('private');
  const error = new Error('private database message');
  await expect(
    clients
      .mongodb(
        {
          findOne: async (...args: unknown[]) => {
            void args;
            throw error;
          },
        },
        'products',
      )
      .findOne({ sku: 'MUG' }, { projection: { _id: 0, stock: 1 } }),
  ).rejects.toBe(error);
  expect(JSON.stringify(state.records)).not.toContain(error.message);
});
it('passes unsupported methods and callbacks through but blocks complete recording', () => {
  const { state, clients } = setup();
  const callback = vi.fn(),
    original = {
      query: vi.fn((...args: unknown[]) => (void args, { stream: true })),
      commit: vi.fn(),
    };
  const client = clients.mysql(original);
  expect(client.query('SELECT price FROM products', callback)).toEqual({ stream: true });
  expect(original.query).toHaveBeenCalledWith('SELECT price FROM products', callback);
  client.commit();
  expect(state.truncate).toHaveBeenCalled();
});
it('does not evaluate parameter getters during capture', async () => {
  const { state, clients } = setup();
  const getter = vi.fn(() => 'MUG');
  const values: unknown[] = [];
  Object.defineProperty(values, '0', { get: getter, enumerable: true });
  await clients
    .mysql({ execute: async (...args: unknown[]) => (void args, [[], []]) })
    .execute(rules[0]!.selector, values);
  expect(getter).not.toHaveBeenCalled();
  expect(state.records[0]?.partial).toBe(true);
});
