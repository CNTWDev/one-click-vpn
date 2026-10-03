import assert from 'node:assert/strict';
import test from 'node:test';
import { ipv4Pool, ipv4Address } from '../server/ipv4-pool.ts';
test('expanded WireGuard pool preserves leases and spans 4093 client addresses', () => {
  const pool = ipv4Pool('10.70.0.0/20');
  assert.equal(pool.gateway, '10.70.0.1/20');
  assert.equal(pool.size - 3, 4093);
  assert.equal(ipv4Address(pool.network + 2), '10.70.0.2');
  assert.equal(ipv4Address(pool.network + pool.size - 2), '10.70.15.254');
  assert.equal(ipv4Pool('10.71.0.0/24').size - 3, 253);
  for (const invalid of ['10.70.1.0/20', '10.999.0.0/24', '8.8.8.0/24', '10.70.0.0/16']) assert.throws(() => ipv4Pool(invalid));
});
