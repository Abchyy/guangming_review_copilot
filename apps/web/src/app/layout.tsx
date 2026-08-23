import type { Metadata } from "next";

import "./globals.css";

export const metadata: Metadata = {
  title: "光明审校 Copilot",
  description: "面向严肃媒体责任编辑的轻量化 AI 审校工具",
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="zh-CN" className="h-full">
      <body className="min-h-full">{children}</body>
    </html>
  );
}
