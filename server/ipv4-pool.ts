/** Small private IPv4 pools; reserve network, gateway and broadcast. */
export function ipv4Pool(cidr: string): { network: number; size: number; gateway: string; prefix: number } {
  const match = cidr.match(/^(\d+)\.(\d+)\.(\d+)\.(\d+)\/(\d+)$/);
  if (!match) throw new Error("Invalid IPv4 address pool");
  const octets = match.slice(1, 5).map(Number), prefix = Number(match[5]);
  if (octets.some((n) => n > 255) || prefix < 20 || prefix > 24) throw new Error("IPv4 pools must use /20 through /24");
  const address = octets.reduce((n, octet) => n * 256 + octet, 0), size = 2 ** (32 - prefix);
  const network = Math.floor(address / size) * size;
  if (address !== network || !(octets[0] === 10 || (octets[0] === 172 && octets[1] >= 16 && octets[1] <= 31) || (octets[0] === 192 && octets[1] === 168))) throw new Error("IPv4 pool must be an aligned private network");
  return { network, size, gateway: `${ipv4Address(network + 1)}/${prefix}`, prefix };
}
export function ipv4Address(value: number): string {
  return [24, 16, 8, 0].map((shift) => (value >>> shift) & 255).join(".");
}
