// src/app/login/page.tsx
'use client';

import { useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { signInWithPopup } from 'firebase/auth';
import { auth, googleProvider, githubProvider } from '@/lib/firebase';
import { useAuth } from '@/contexts/AuthContext';
import { Button } from '@/components/ui/button';
import { Chrome, GithubIcon } from 'lucide-react';
import { useToast } from '@/hooks/use-toast';
import { Loader2 } from 'lucide-react';

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

  if (loading) {
    return (
      <div className="min-h-screen flex flex-col items-center justify-center bg-black p-4 text-white">
        <Loader2 className="h-12 w-12 animate-spin mb-4" />
        <p>Loading session...</p>
      </div>
    );
  }
  
  // If already logged in (and not loading), useEffect will redirect. Show minimal loading state.
  if (currentUser) {
     return (
      <div className="min-h-screen flex flex-col items-center justify-center bg-black p-4 text-white">
        <Loader2 className="h-12 w-12 animate-spin mb-4" />
        <p>Redirecting...</p>
      </div>
    );
  }


  return (
    <div className="min-h-screen flex flex-col items-center justify-center bg-black p-4">
      <div className="space-y-6 w-full max-w-xs">
        <Button
          onClick={() => handleSignIn(googleProvider)}
          variant="outline" // Uses themed outline for B&W
          className="w-full text-lg py-6"
        >
          <Chrome className="h-6 w-6 mr-3" />
          Sign in with Google
        </Button>
        <Button
          onClick={() => handleSignIn(githubProvider)}
          variant="outline" // Uses themed outline for B&W
          className="w-full text-lg py-6"
        >
          <GithubIcon className="h-6 w-6 mr-3" />
          Sign in with GitHub
        </Button>
      </div>
    </div>
  );
}
