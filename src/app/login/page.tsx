// src/app/login/page.tsx
'use client';

import { useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { signInWithPopup, type AuthProvider as FirebaseAuthProvider } from 'firebase/auth';
import { auth, googleProvider, githubProvider, firebaseConfig } from '@/lib/firebase'; // Import firebaseConfig
import { useAuth } from '@/contexts/AuthContext';
import { Button } from '@/components/ui/button';
import { Chrome, GithubIcon, Loader2 } from 'lucide-react';
import { useToast } from '@/hooks/use-toast';

export default function LoginPage() {
  const { currentUser, loading } = useAuth();
  const router = useRouter();
  const { toast } = useToast();

  useEffect(() => {
    if (!loading && currentUser) {
      router.push('/dashboard');
    }
  }, [currentUser, loading, router]);

  const handleSignIn = async (provider: FirebaseAuthProvider) => {
    try {
      await signInWithPopup(auth, provider);
      toast({ title: "Sign In Successful", description: "Redirecting to dashboard..." });
      router.push('/dashboard');
    } catch (error: any) {
      console.error("Sign in error:", error);
      let description = error.message || "An unexpected error occurred during sign-in.";
      if (error.code === 'auth/unauthorized-domain') {
        description = `This app's domain is not authorized for Firebase sign-in. Please ensure 'localhost' is an authorized domain for Firebase project ID: '${firebaseConfig.projectId}'. Check Authentication > Sign-in method > Authorized domains in your Firebase console. Details: ${error.message}`;
      }
      toast({
        title: "Sign In Failed",
        description: description,
        variant: "destructive",
        duration: 9000, 
      });
    }
  };

  if (loading || (!loading && currentUser)) {
    return (
      <div className="min-h-screen w-full flex flex-col items-center justify-center bg-black p-4 text-center relative">
        <Loader2 className="h-16 w-16 animate-spin mb-6 text-white" />
        <p className="text-xl text-white">Loading session...</p>
      </div>
    );
  }

  return (
    <div className="min-h-screen w-full flex flex-col items-center justify-center bg-black p-6 text-center relative">
      <div className="relative z-10 flex flex-col items-center">
        <h1
          className="text-7xl sm:text-8xl md:text-9xl font-bold tracking-tight mb-12 animate-fadeIn animated-gradient-text-fill"
          data-text="DeployEase"
        >
          DeployEase
        </h1>

        <div className="space-y-6 w-full max-w-xs">
          <Button
            onClick={() => handleSignIn(googleProvider)}
            variant="outline"
            className="w-full text-lg py-6 bg-white text-black border border-gray-600 hover:bg-white hover:text-black hover:border-gray-400 transition-all duration-300 ease-in-out transform hover:scale-105"
            aria-label="Sign in with Google"
          >
            <Chrome className="h-6 w-6 mr-3" />
            Sign in with Google
          </Button>
          <Button
            onClick={() => handleSignIn(githubProvider)}
            variant="outline"
            className="w-full text-lg py-6 bg-white text-black border border-gray-600 hover:bg-white hover:text-black hover:border-gray-400 transition-all duration-300 ease-in-out transform hover:scale-105"
            aria-label="Sign in with GitHub"
          >
            <GithubIcon className="h-6 w-6 mr-3" />
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
