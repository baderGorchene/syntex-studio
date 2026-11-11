import type { Metadata } from "next";
import { Caveat, Kalam } from "next/font/google";
import { ClerkProvider } from "@clerk/nextjs";
import "./globals.css";
import "./typeset.css";
import "./paper.css";
import "./landing.css";
import "./auth.css";
import "./collab.css";
import "./mobile.css";

// Handwritten type to match the paper board: Kalam for running text, Caveat for titles and the writing pad.
const kalam = Kalam({ subsets: ["latin"], weight: ["300", "400", "700"], variable: "--font-kalam" });
const caveat = Caveat({ subsets: ["latin"], variable: "--font-caveat" });

export const metadata: Metadata = {
  title: "Synthex Studio",
  description: "Ask a question, get a sourced map you can check, keep what's right, share it anywhere.",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  const hasClerk = Boolean(process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY);

  const bodyContent = (
    <html lang="en" className={`h-full antialiased ${kalam.variable} ${caveat.variable}`}>
      <body className="h-full w-full overflow-hidden m-0 p-0 font-sans" suppressHydrationWarning>
        {children}
      </body>
    </html>
  );

  if (hasClerk) {
    return <ClerkProvider>{bodyContent}</ClerkProvider>;
  }

  return bodyContent;
}
