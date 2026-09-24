import test from 'node:test';
import assert from 'node:assert/strict';
import { renderMihomoWireGuard } from '../server/protocols/mihomo.ts';

const input = {
  name: 'WG-test', endpoint: { host: 'vpn.example.com', port: 51820 },
  privateKey: Buffer.alloc(32, 1).toString('base64'), serverPublicKey: Buffer.alloc(32, 2).toString('base64'),
  clientAddress: '10.70.0.2/32', dns: ['1.1.1.1'], allowedIps: ['0.0.0.0/0'],
};
const proxy = (text) => JSON.parse(text.split('proxies:\n  - ')[1].split('\n')[0]);
test('Mihomo export reuses WireGuard identity, endpoint and routes', () => {
  const text = renderMihomoWireGuard(input);
  const p = proxy(text);
  assert.equal(p.ip, '10.70.0.2');
  assert.equal(p['private-key'], input.privateKey);
  assert.equal(p['public-key'], input.serverPublicKey);
  assert.equal(p.server, input.endpoint.host);
  assert.equal(p.port, 51820);
  assert.deepEqual(p['allowed-ips'], input.allowedIps);
  assert.equal(p['persistent-keepalive'], 25);
  assert.equal(p['remote-dns-resolve'], true);
  assert.match(text, /allow-lan: false/);
  assert.match(text, /MATCH,Northstar/);
  assert.doesNotMatch(text, /external-controller|tun:/);
  const dns = JSON.parse(text.split('\n').find(line => line.startsWith('dns: ')).slice(5));
  assert.equal(dns['respect-rules'], true);
  assert.ok(dns['proxy-server-nameserver'].length);
});
test('YAML data cannot inject extra configuration', () => {
  const name = 'x"\nrules:\n  - MATCH,DIRECT #';
  const text = renderMihomoWireGuard({ ...input, name });
  assert.equal(proxy(text).name, name);
  assert.equal(text.split('\n').filter(line => line === 'rules:').length, 1);
});
test('preserves split routes, supplies DNS fallback and supports IPv6 endpoints', () => {
  const p = proxy(renderMihomoWireGuard({ ...input, endpoint: { host: '2001:db8::1', port: 51820 }, allowedIps: ['10.0.0.0/8'], dns: [] }));
  assert.deepEqual(p['allowed-ips'], ['10.0.0.0/8']);
  assert.deepEqual(p.dns, ['1.1.1.1']);
  assert.equal(p.server, '2001:db8::1');
});
test('fails closed for missing keys or unsupported address/route/DNS', () => {
  for (const change of [{ privateKey: '' }, { serverPublicKey: 'invalid' }, { clientAddress: '::1/128' }, { allowedIps: [] }, { allowedIps: ['0.0.0.0/99'] }, { dns: ['not-an-ip'] }, { endpoint: { host: 'bad\nhost', port: 1 } }, { endpoint: { host: 'host', port: 65536 } }]) {
    assert.throws(() => renderMihomoWireGuard({ ...input, ...change }));
  }
});
