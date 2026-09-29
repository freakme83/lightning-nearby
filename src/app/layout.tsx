import type { Metadata, Viewport } from "next";
import "leaflet/dist/leaflet.css";
import "./styles.css";

export const metadata: Metadata = {
  title: "Lightning Nearby",
  description: "A calm, local 24-hour thunderstorm outlook.",
  applicationName: "Lightning Nearby",
  manifest: "/manifest.webmanifest",
  appleWebApp: { capable: true, statusBarStyle: "black-translucent", title: "Lightning" },
  icons: { icon: [{ url: "/icons/icon.svg", type: "image/svg+xml" }], apple: [{ url: "/icons/apple-touch-icon.png", sizes: "180x180", type: "image/png" }] },
};
export const viewport: Viewport = { themeColor: "#101a27", width: "device-width", initialScale: 1, viewportFit: "cover" };
export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return <html lang="en"><body>{children}</body></html>;
}
