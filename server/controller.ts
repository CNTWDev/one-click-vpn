import { lookup } from "node:dns/promises";
import { loadavg } from "node:os";
import { publicOrigin } from "./config";
import { getControllerSettings, type ControllerSettings } from "./db";

export type ControllerInfo = {
  settings: ControllerSettings;
  status: "healthy";
  publicOrigin: string;
  publicHost: string;
  publicIp: string | null;
  build: string;
  runtime: { uptimeSeconds: number; nodeVersion: string; rssBytes: number; heapUsedBytes: number; load1: number; observedAt: string };
};

function originDetails(): { origin: string; host: string } {
  const origin = publicOrigin();
  try {
    return { origin, host: new URL(origin).hostname };
  } catch {
    return { origin, host: "" };
  }
}

async function resolvePublicIp(host: string): Promise<string | null> {
  if (!host) return null;
  try {
    const addresses = await lookup(host, { all: true, verbatim: true });
    return addresses.find((entry) => entry.family === 4)?.address || addresses[0]?.address || null;
  } catch {
    return null;
  }
}

export async function controllerInfo(): Promise<ControllerInfo> {
  const { origin, host } = originDetails();
  const [settings, publicIp] = await Promise.all([getControllerSettings(), resolvePublicIp(host)]);
  return {
    settings,
    status: "healthy",
    publicOrigin: origin,
    publicHost: host,
    publicIp,
    build: process.env.NORTHSTAR_BUILD_REV || "unknown",
    runtime: {
      uptimeSeconds: Math.floor(process.uptime()), nodeVersion: process.version,
      rssBytes: process.memoryUsage().rss, heapUsedBytes: process.memoryUsage().heapUsed,
      load1: loadavg()[0], observedAt: new Date().toISOString(),
    },
  };
}
