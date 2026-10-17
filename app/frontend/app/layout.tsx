import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "ふうせん",
  description: "頑張らなくていいダイエット記録",
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="ja">
      <body>{children}</body>
    </html>
  );
}
