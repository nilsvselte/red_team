import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Special Participation A Dashboard",
  description: "CSV-backed dashboard with AI summaries grouped by homework and model.",
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
