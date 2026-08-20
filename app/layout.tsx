import type { Metadata } from "next";
import "@fontsource-variable/inter";
import "@fontsource/instrument-serif";
import "./globals.css";
import Sidebar from "@/components/Sidebar";
import AIPanel from "@/components/AIPanel";
import { DataModeProvider } from "@/components/DataModeProvider";
import { getDataMode, DEMO_MODE } from "@/lib/dataMode";
import { headers } from "next/headers";

export const metadata: Metadata = { title: "AdLens — Ad Intelligence", description: "AI-powered ad campaign intelligence" };

// The layout reads whether this deployment holds real data, so every page is
// rendered per request rather than prerendered with a stale answer.
export const dynamic = "force-dynamic";

const themeInit = `(function(){try{var t=localStorage.getItem("adlens-theme");if(t!=="light")document.documentElement.classList.add("dark")}catch(e){document.documentElement.classList.add("dark")}})();`;

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  // The login screen gets no navigation and no AI panel: there is nothing to
  // navigate to yet, and the chrome should not be part of a signed-out page.
  const bare = headers().get("x-pathname") === "/login";
  const mode = bare ? DEMO_MODE : await getDataMode();

  return (
    <html lang="en" suppressHydrationWarning>
      <head><script dangerouslySetInnerHTML={{ __html: themeInit }} /></head>
      <body className="h-screen overflow-hidden">
        <DataModeProvider value={mode}>
          {bare ? (
            <main className="h-screen overflow-y-auto">{children}</main>
          ) : (
            <>
              <div className="flex h-screen">
                <Sidebar />
                <main className="flex-1 overflow-y-auto">{children}</main>
              </div>
              <AIPanel />
            </>
          )}
        </DataModeProvider>
      </body>
    </html>
  );
}
