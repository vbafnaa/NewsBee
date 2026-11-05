import type { Metadata } from "next";
import type { ReactNode } from "react";
import "../../../shared/design-tokens.css";
import "./styles.css";

export const metadata: Metadata = {
  title: "Newsbee Journalist",
  description: "Manage Newsbee sources and publishing operations.",
};

export default function RootLayout({ children }: Readonly<{ children: ReactNode }>) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
