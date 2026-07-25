import type { Metadata } from "next";
import { headers } from "next/headers";
import "./globals.css";

export const dynamic = "force-dynamic";

export async function generateMetadata(): Promise<Metadata> {
  const requestHeaders = await headers();
  const configuredOrigin = process.env.NORTHSTAR_PUBLIC_ORIGIN?.trim();
  const forwardedHost = requestHeaders.get("x-forwarded-host") || requestHeaders.get("host");
  const forwardedProtocol = (requestHeaders.get("x-forwarded-proto") || "https").split(",")[0].trim();
  const origin = configuredOrigin || (forwardedHost ? `${forwardedProtocol}://${forwardedHost}` : "http://localhost:3000");

  return {
    metadataBase: new URL(origin),
    title: "Northstar Control Plane",
    description: "Single-machine control plane for secure global VPN node operations.",
    openGraph: {
      title: "Northstar Control Plane",
      description: "Operate the edge, not the overhead.",
      images: ["/og.png"],
    },
    twitter: {
      card: "summary_large_image",
      title: "Northstar Control Plane",
      images: ["/og.png"],
    },
    icons: {
      icon: "/favicon.svg",
      shortcut: "/favicon.svg",
    },
  };
}

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
