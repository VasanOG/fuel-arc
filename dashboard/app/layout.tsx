import type { Metadata } from "next";
import { IBM_Plex_Mono, IBM_Plex_Sans } from "next/font/google";
import { AppShell } from "@/components/shell/AppShell";
import "./globals.css";

/**
 * IBM Plex, in two roles.
 *
 * Mono for every figure and document number, because a ledger is a thing whose
 * columns have to align and whose digits have to be comparable at a glance —
 * that is what monospace is for, and it is the vernacular financial systems
 * have printed in for decades. Sans for everything a person reads as prose.
 * One superfamily, so the two never look like a collision.
 *
 * Loaded here rather than on the accounting page, which is where it used to
 * live. The two pages were set in different faces and did not look like the
 * same product; one superfamily for the whole application fixes that in one
 * move.
 */
const plexSans = IBM_Plex_Sans({
  subsets: ["latin"],
  weight: ["400", "500", "600"],
  variable: "--font-plex-sans",
});

const plexMono = IBM_Plex_Mono({
  subsets: ["latin"],
  weight: ["400", "500"],
  variable: "--font-plex-mono",
});

export const metadata: Metadata = {
  title: "Fuel",
  description: "Financial control and accounting for autonomous agents.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={`${plexSans.variable} ${plexMono.variable}`}>
      <body>
        <AppShell>{children}</AppShell>
      </body>
    </html>
  );
}
