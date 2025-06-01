// src/app/layout.tsx
'use client'; // Required for usePathname

import type { Metadata } from 'next';
import { usePathname } from 'next/navigation'; // Import usePathname
import './globals.css';
import { Toaster } from '../components/ui/toaster'; // Changed from @/components/ui/toaster
import { AuthProvider } from '../contexts/AuthContext'; // Changed from @/contexts/AuthContext
import { Navbar } from '../components/Navbar'; // Changed from @/components/Navbar

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
  const pathname = usePathname();
  const showNavbar = pathname !== '/'; // Hide Navbar on the new home/login page

  return (
    <html lang="en">
      <head>
        {/* Metadata can be set here if static, or in individual page.tsx files for dynamic titles */}
        <title>DeployEase</title>
        <meta name="description" content="Effortless deployment for your React and static web projects." />
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="anonymous" />
        <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;700;900&display=swap" rel="stylesheet" />
      </head>
      <body className="font-body antialiased bg-background text-foreground">
        <AuthProvider>
          {showNavbar && <Navbar />}
          <main>{children}</main>
          <Toaster />
        </AuthProvider>
      </body>
    </html>
  );
}
