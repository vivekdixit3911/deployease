// src/components/Navbar.tsx
'use client';

// Imports for Link, Button, useAuth, LogOut, UserCircle, LayoutDashboard, Avatar, AvatarFallback, AvatarImage are no longer needed.

export function Navbar() {
  // const { currentUser, signOut, loading } = useAuth(); // No longer needed
  // const getInitials = (name: string | null | undefined) => { ... }; // No longer needed

  return (
    <nav className="bg-card shadow-md sticky top-0 z-50">
      <div className="container mx-auto px-4 sm:px-6 lg:px-8">
        <div className="flex items-center justify-end h-16">
          {/* All interactive content (buttons, avatar, user info, loading state) previously here has been removed */}
        </div>
      </div>
    </nav>
  );
}
