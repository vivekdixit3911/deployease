// src/app/login/page.tsx
'use client';

import { useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { signInWithPopup } from 'firebase/auth';
import { auth, googleProvider, githubProvider } from '@/lib/firebase';
import { useAuth } from '@/contexts/AuthContext';
import { Button } from '@/components/ui/button';
import { Chrome, GithubIcon, Loader2 } from 'lucide-react'; // Changed from Github
import { useToast } from '@/hooks/use-toast';

// This page can now serve as a direct link to login if needed, 
// but the primary login experience is intended for the home page (/).
export default function LoginPage() {
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
      toast({ title: "Sign In Successful", description: "Redirecting to dashboard..." });
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

  if (loading || (!loading && currentUser)) {
    return (
      <div className="min-h-screen flex flex-col items-center justify-center bg-black p-4 text-white">
        <Loader2 className="h-12 w-12 animate-spin mb-4 text-primary-foreground" />
        <p className="text-primary-foreground">Loading session...</p>
      </div>
    );
  }
  
  return (
    <div className="min-h-screen flex flex-col items-center justify-center bg-black p-4">
      <div className="mb-12 text-center">
          <h1 className="text-5xl font-bold text-primary-foreground mb-3">Login to DeployEase</h1>
          <p className="text-muted-foreground">Choose your preferred method to sign in.</p>
      </div>
      <div className="space-y-6 w-full max-w-xs">
        <Button
          onClick={() => handleSignIn(googleProvider)}
          variant="outline" 
          className="w-full text-lg py-6 bg-transparent hover:bg-primary-foreground/10 border-primary-foreground/50 text-primary-foreground hover:text-primary-foreground"
          aria-label="Sign in with Google"
        >
          <Chrome className="h-6 w-6 mr-3" />
          Sign in with Google
        </Button>
        <Button
          onClick={() => handleSignIn(githubProvider)}
          variant="outline" 
          className="w-full text-lg py-6 bg-transparent hover:bg-primary-foreground/10 border-primary-foreground/50 text-primary-foreground hover:text-primary-foreground"
          aria-label="Sign in with GitHub"
        >
          <GithubIcon className="h-6 w-6 mr-3" />
          Sign in with GitHub
        </Button>
      </div>
    </div>
  );
}
