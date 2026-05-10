import type { Metadata } from "next";
import { Inter, JetBrains_Mono } from "next/font/google";
import "./globals.css";
import { QueryProvider } from "@/components/QueryProvider";
import { GlobalMouseTrail } from "@/components/3d/GlobalMouseEffects";

const inter = Inter({
  subsets: ["latin"],
  variable: "--font-sans",
  display: "swap",
});

const jetbrainsMono = JetBrains_Mono({
  subsets: ["latin"],
  variable: "--font-mono",
  display: "swap",
});

export const metadata: Metadata = {
  title: "GLM Ledger — India's Most Powerful Accounting Platform",
  description: "Next-generation accounting software for Indian businesses. GST-compliant, double-entry bookkeeping, e-invoicing, payroll, and more.",
  keywords: "accounting, GST, India, ledger, bookkeeping, SaaS, tally, e-invoicing",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" className={`${inter.variable} ${jetbrainsMono.variable}`}>
      <body className="font-sans antialiased" style={{ background: 'transparent' }}>
        <QueryProvider>
          {children}
          <GlobalMouseTrail />
        </QueryProvider>
      </body>
    </html>
  );
}
