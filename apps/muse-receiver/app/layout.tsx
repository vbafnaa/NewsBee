import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Muse Receiver",
  description: "Collect and review Facebook group observations reported by Muse.",
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
