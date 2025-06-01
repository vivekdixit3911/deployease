// src/app/page.tsx
'use client';

import { useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { signInWithPopup } from 'firebase/auth';
import { auth, googleProvider, githubProvider } from '@/lib/firebase';
import { useAuth } from '@/contexts/AuthContext';
import { Button } from '@/components/ui/button';
import { Chrome, GithubIcon, Loader2 } from 'lucide-react'; // Standardized to GithubIcon
import { useToast } from '@/hooks/use-toast';

export default function HomePage() {
  const { currentUser, loading } = useAuth();
  const router = useRouter();
  const { toast } = useToast();

  useEffect(() => {
    if (!loading && currentUser) {
      router.push('/dashboard'); // Redirect if already logged in
    }
  }, [currentUser, loading, router]);

  const handleSignIn = async (provider: typeof googleProvider | typeof githubProvider) => {
    try {
      await signInWithPopup(auth, provider);
      toast({ title: "Sign In Successful", description: "Welcome!" });
      router.push('/dashboard');
    } catch (error: any) {
      console.error("Sign in error:", error);
      toast({
        title: "Sign In Failed",
        description: error.message || "An unexpected error occurred during sign-in.",
        variant: "destructive",
      });
    }
  };

  if (loading || (!loading && currentUser)) { // Show loader if auth is loading or if user is logged in (and about to be redirected)
    return (
      <div className="min-h-screen flex flex-col items-center justify-center bg-black p-4 text-white">
        <Loader2 className="h-16 w-16 animate-spin mb-6 text-primary-foreground" />
        <p className="text-xl">Loading session...</p>
      </div>
    );
  }

  return (
    <div className="min-h-screen w-full flex flex-col items-center justify-center bg-black p-6 text-center relative overflow-hidden">
      {/* Placeholder for potential future animated stars background */}
      {/* <div className="absolute inset-0 z-0"> Add star animation here </div> */}
      
      <div className="relative z-10 flex flex-col items-center">
        <h1 className="text-7xl sm:text-8xl md:text-9xl font-bold text-primary-foreground tracking-tight mb-12 animate-fadeIn">
          DeployEase
        </h1>

        <div className="space-y-6 w-full max-w-xs">
          <Button
            onClick={() => handleSignIn(googleProvider)}
            variant="outline"
            className="w-full text-lg py-6 bg-transparent hover:bg-primary-foreground/10 border-primary-foreground/50 text-primary-foreground hover:text-primary-foreground transition-all duration-300 ease-in-out transform hover:scale-105"
            aria-label="Sign in with Google"
          >
            <Chrome className="h-6 w-6 mr-3" />
            Sign in with Google
          </Button>
          <Button
            onClick={() => handleSignIn(githubProvider)}
            variant="outline"
            className="w-full text-lg py-6 bg-transparent hover:bg-primary-foreground/10 border-primary-foreground/50 text-primary-foreground hover:text-primary-foreground transition-all duration-300 ease-in-out transform hover:scale-105"
            aria-label="Sign in with GitHub"
          >
            <GithubIcon className="h-6 w-6 mr-3" /> {/* Standardized to GithubIcon */}
            Sign in with GitHub
          </Button>
        </div>
      </div>
      <style jsx global>{`
        @keyframes fadeIn {
          from { opacity: 0; transform: translateY(20px); }
          to { opacity: 1; transform: translateY(0); }
        }
        .animate-fadeIn {
          animation: fadeIn 1s ease-out forwards;
        }
      `}</style>
    </div>
  );
}
