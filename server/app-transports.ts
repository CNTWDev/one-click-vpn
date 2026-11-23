/** App transport names and the node service port they use. */
export const appTransports: Record<string, { protocol: string; transport: "udp" | "tcp" }> = {
  wireguard: { protocol: "wireguard", transport: "udp" },
  hysteria2: { protocol: "stealth", transport: "udp" },
  reality: { protocol: "vless", transport: "tcp" },
  // REALITY on the node's spare port (hop-ports.ts).
  "reality-alt": { protocol: "vless", transport: "tcp" },
  xhttp: { protocol: "stealth", transport: "tcp" },
};
