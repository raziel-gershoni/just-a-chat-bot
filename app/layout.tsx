import type { ReactNode } from "react";
import { LANG_SCRIPT } from "./lang-script";
import "./globals.css";

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    // The inline script sets lang/dir before hydration, so React must not flag the difference.
    <html lang="en" dir="ltr" suppressHydrationWarning>
      <head>
        {/* A plain blocking script, as Telegram documents: next/script's beforeInteractive loads it
            after inline head scripts in the app router, so the language script below couldn't read it. */}
        <script src="https://telegram.org/js/telegram-web-app.js" />
        <script dangerouslySetInnerHTML={{ __html: LANG_SCRIPT }} />
      </head>
      <body className="antialiased">{children}</body>
    </html>
  );
}
