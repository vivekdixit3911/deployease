// src/app/layout.tsx
'use client'; // Required for AuthProvider and Toaster hooks if they use client features

// import type { Metadata } from 'next'; // Metadata often better in page.tsx for client components
import './globals.css';
import { Toaster } from '../components/ui/toaster';
import { AuthProvider } from '../contexts/AuthContext';

// Metadata can't be dynamic in a client component root layout easily,
// so we define it statically. If dynamic metadata is needed per page,
// it should be handled in individual page.tsx files.
// export const metadata: Metadata = {
// title: 'DeployEase',
// description: 'Effortless deployment for your React and static web projects.',
// };

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <head>
        {/* Metadata can be set here if static, or in individual page.tsx files for dynamic titles */}
        <title>DeployEase</title>
        <meta name="description" content="Effortless deployment for your React and static web projects." />
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="anonymous" />
        {/* Updated to include 400, 700, 900 weights for Inter font */}
        <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;700;900&display=swap" rel="stylesheet" />
      </head>
      <body className="font-body antialiased bg-background text-foreground">
        <AuthProvider>
          <main>{children}</main>
          <Toaster />
        </AuthProvider>
      </body>
    </html>
  );
}
