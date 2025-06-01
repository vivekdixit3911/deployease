// src/components/Navbar.tsx
'use client';

import Link from 'next/link';
import { Button } from '@/components/ui/button';
import { useAuth } from '@/contexts/AuthContext';
import { LogIn, LogOut, UserCircle, LayoutDashboard } from 'lucide-react'; // Removed UploadCloud as it's no longer used
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";

export function Navbar() {
  const { currentUser, signOut, loading } = useAuth();

  const getInitials = (name: string | null | undefined) => {
    if (!name) return '';
    const names = name.split(' ');
    if (names.length === 1) return names[0][0].toUpperCase();
    return names[0][0].toUpperCase() + names[names.length - 1][0].toUpperCase();
  };

  return (
    <nav className="bg-card shadow-md sticky top-0 z-50">
      <div className="container mx-auto px-4 sm:px-6 lg:px-8">
        <div className="flex items-center justify-end h-16"> {/* Changed justify-between to justify-end */}
          {/* "DeployEase" branding (icon and title) has been removed */}
          <div className="flex items-center space-x-3">
            {!loading && currentUser && (
              <>
                <Button variant="ghost" asChild>
                  <Link href="/dashboard" className="flex items-center">
                    <LayoutDashboard className="h-5 w-5 mr-1" />
                    Dashboard
                  </Link>
                </Button>
                <Avatar className="h-9 w-9">
                  <AvatarImage src={currentUser.photoURL || undefined} alt={currentUser.displayName || 'User'} />
                  <AvatarFallback>{getInitials(currentUser.displayName)}</AvatarFallback>
                </Avatar>
                <span className="text-sm font-medium text-foreground hidden sm:inline">
                  {currentUser.displayName || currentUser.email}
                </span>
                <Button variant="outline" onClick={signOut} size="sm">
                  <LogOut className="h-4 w-4 mr-1 sm:mr-2" />
                  <span className="hidden sm:inline">Sign Out</span>
                </Button>
              </>
            )}
            {!loading && !currentUser && (
              <Button asChild size="sm">
                <Link href="/login" className="flex items-center">
                  <LogIn className="h-4 w-4 mr-1 sm:mr-2" />
                  Sign In
                </Link>
              </Button>
            )}
            {loading && (
               <UserCircle className="h-6 w-6 text-muted-foreground animate-pulse" />
            )}
          </div>
        </div>
      </div>
    </nav>
  );
}
