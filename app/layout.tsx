import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  metadataBase: new URL(process.env.NORTHSTAR_PUBLIC_ORIGIN || "http://localhost:3000"),
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
    description: "Operate the edge, not the overhead.",
    images: ["/og.png"],
  },
  icons: {
    icon: "/favicon.svg",
    shortcut: "/favicon.svg",
  },
};

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
