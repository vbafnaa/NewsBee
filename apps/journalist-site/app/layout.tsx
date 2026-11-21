import type { Metadata } from "next";
import type { ReactNode } from "react";
import "../../../shared/design-tokens.css";
import "./styles.css";

export const metadata: Metadata = {
  title: "Newsbee",
  description: "Newsbee Newsroom publication workspaces and Newsbee Admin platform operations.",
};

export default function RootLayout({ children }: Readonly<{ children: ReactNode }>) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
