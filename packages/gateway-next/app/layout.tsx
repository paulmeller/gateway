export const metadata = {
  title: "managed-agents",
  description: "Self-hosted Agent Gateway — Managed Agents API format",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
