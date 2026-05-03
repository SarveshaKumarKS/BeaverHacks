import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "The Consensus Duo",
  description: "A real-time AI debate arena for group decisions"
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en" suppressHydrationWarning>
      <body>{children}</body>
    </html>
  );
}

