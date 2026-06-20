import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  metadataBase: new URL("https://getrecommendedbyai.net"),
  title: {
    default: "GetRecommendedByAi",
    template: "%s | GetRecommendedByAi"
  },
  description: "GEO citation gap scanner for AI recommendation readiness.",
  icons: {
    icon: "/logo.svg",
    shortcut: "/logo.svg",
    apple: "/logo.svg"
  },
  openGraph: {
    title: "GetRecommendedByAi",
    description: "Scan a URL, discover GEO citation gaps, and generate AI-ready optimization advice.",
    url: "https://getrecommendedbyai.net",
    siteName: "GetRecommendedByAi",
    type: "website"
  }
};

export default function RootLayout({
  children
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
