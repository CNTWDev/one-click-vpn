import test from 'node:test';
import assert from 'node:assert/strict';
import { nativeWireGuardAllowedIps, WIREGUARD_CLIENT_MTU } from '../server/protocols/wireguard.ts';

test('full-tunnel WireGuard profiles also capture IPv6 so Android cannot leak it', () => {
  assert.deepEqual(nativeWireGuardAllowedIps(['0.0.0.0/0']), ['0.0.0.0/0', '::/0']);
  assert.deepEqual(nativeWireGuardAllowedIps(['0.0.0.0/0', '::/0']), ['0.0.0.0/0', '::/0']);
  assert.deepEqual(nativeWireGuardAllowedIps(['10.0.0.0/8']), ['10.0.0.0/8']);
  assert.equal(WIREGUARD_CLIENT_MTU, 1280);
});
