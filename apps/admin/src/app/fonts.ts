import localFont from "next/font/local";

// Self-hosted variable fonts (SIL OFL, see fonts/LICENSE.txt): no third-party font requests, CSP font-src 'self'.
export const display = localFont({ src: "./fonts/instrument-sans.woff2", variable: "--font-display", weight: "400 700", display: "swap" });
export const mono = localFont({ src: "./fonts/jetbrains-mono.woff2", variable: "--font-mono-face", weight: "400 700", display: "swap" });
