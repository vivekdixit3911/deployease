
// src/app/page.tsx
'use client';

import { useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { signInWithPopup, type AuthProvider as FirebaseAuthProvider } from 'firebase/auth';
import { auth, googleProvider, githubProvider, firebaseConfig } from '@/lib/firebase';
import { useAuth } from '@/contexts/AuthContext';
import { Button } from '@/components/ui/button';
import { Chrome, GithubIcon, Loader2 } from 'lucide-react';
import { useToast } from '@/hooks/use-toast';
import { Navbar } from '@/components/Navbar';
// UploadCard is not directly rendered here anymore, users go to dashboard after login
// import { UploadCard } from '@/components/deploy-ease/UploadCard';


export default function HomePage() {
  const { currentUser, loading } = useAuth();
  const router = useRouter();
  const { toast } = useToast();

  useEffect(() => {
    if (!loading && currentUser) {
      router.push('/dashboard');
    }
  }, [currentUser, loading, router]);

  const handleSignIn = async (provider: FirebaseAuthProvider) => {
    if (!auth) {
        toast({ title: "Authentication Error", description: "Firebase Auth is not initialized.", variant: "destructive" });
        return;
    }
    try {
      await signInWithPopup(auth, provider);
      toast({ title: "Signed In Successfully!", description: "Redirecting to your dashboard..." });
      router.push('/dashboard');
    } catch (error: any) {
      console.error("Sign in error:", error);
      let description = "An unknown error occurred during sign-in.";
      if (error.code === 'auth/popup-closed-by-user') {
        description = "Sign-in popup was closed before completion.";
      } else if (error.code === 'auth/cancelled-popup-request') {
        description = "Sign-in popup request was cancelled.";
      } else if (error.code === 'auth/popup-blocked') {
        description = "Popup was blocked by the browser. Please allow popups for this site.";
      } else if (error.code === 'auth/unauthorized-domain') {
        description = `This app's domain is not authorized for Firebase sign-in. Please ensure 'localhost' (for local dev) or your deployed domain is in the authorized domains list for Firebase project ID: ${firebaseConfig.projectId || 'UNKNOWN'}. Check Firebase console.`;
      }
      toast({
        title: "Sign In Failed",
        description: description,
        variant: "destructive",
      });
    }
  };

  if (loading || (!loading && currentUser)) {
    return (
      <div className="min-h-screen w-full flex flex-col items-center justify-center bg-background p-4 text-center relative">
        <Navbar />
        <div className="flex-grow flex flex-col items-center justify-center">
          <Loader2 className="h-16 w-16 animate-spin mb-6 text-primary" />
          <p className="text-xl text-muted-foreground">Loading session...</p>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen w-full flex flex-col items-center bg-background pt-4 sm:pt-8 md:pt-12 p-4">
      <Navbar />
      <div className="flex flex-col items-center justify-center flex-grow w-full text-center">
        <h1
          className="text-6xl sm:text-7xl md:text-8xl font-bold tracking-tight mb-8 animated-gradient-text-fill"
          data-text="DeployEase"
        >
          DeployEase
        </h1>
        <p className="text-xl sm:text-2xl text-muted-foreground mb-12 max-w-2xl">
          The simplest way to deploy your React and static web projects.
          Connect your GitHub or upload a ZIP and get your site live in minutes.
        </p>
        
        <div className="space-y-4 sm:space-y-0 sm:space-x-4 flex flex-col sm:flex-row items-center justify-center">
           {googleProvider && (
            <Button
              onClick={() => handleSignIn(googleProvider)}
              size="lg"
              className="w-full sm:w-auto text-lg py-7 px-8 bg-card hover:bg-card/90 border border-input"
            >
              <Chrome className="mr-3 h-6 w-6" /> Sign In with Google
            </Button>
          )}
          {githubProvider && (
            <Button
              onClick={() => handleSignIn(githubProvider)}
              size="lg"
              className="w-full sm:w-auto text-lg py-7 px-8 bg-card hover:bg-card/90 border border-input"
            >
              <GithubIcon className="mr-3 h-6 w-6" /> Sign In with GitHub
            </Button>
          )}
        </div>
         <p className="mt-8 text-sm text-muted-foreground">
          No account? Signing in will create one for you.
        </p>
      </div>
    </div>
  );
}
