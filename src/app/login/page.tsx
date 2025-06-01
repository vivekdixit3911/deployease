// src/app/login/page.tsx
'use client';

import { useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { signInWithPopup } from 'firebase/auth';
import { auth, googleProvider, githubProvider } from '@/lib/firebase';
import { useAuth } from '@/contexts/AuthContext';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Chrome, GithubIcon } from 'lucide-react'; // Using GithubIcon as lucide-react typically names it
import { useToast } from '@/hooks/use-toast';

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
      toast({ title: "Sign In Successful", description: "Welcome back!" });
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
    // Show loading or let useEffect handle redirect
    return (
      <div className="min-h-screen flex items-center justify-center">
        <p>Loading or Redirecting...</p>
      </div>
    );
  }

  return (
    <div className="min-h-screen flex flex-col items-center justify-center bg-gradient-to-br from-primary/10 via-background to-secondary/10 p-4">
      <Card className="w-full max-w-md shadow-2xl">
        <CardHeader className="text-center">
          <CardTitle className="text-3xl font-bold tracking-tight text-primary">Welcome to DeployEase</CardTitle>
          <CardDescription className="text-muted-foreground pt-2">
            Sign in to deploy and manage your projects effortlessly.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-6 p-8">
          <Button
            onClick={() => handleSignIn(googleProvider)}
            className="w-full text-lg py-6 bg-red-600 hover:bg-red-700 text-white"
          >
            <Chrome className="h-6 w-6 mr-3" />
            Sign in with Google
          </Button>
          <Button
            onClick={() => handleSignIn(githubProvider)}
            className="w-full text-lg py-6 bg-gray-800 hover:bg-gray-900 text-white"
          >
            <GithubIcon className="h-6 w-6 mr-3" />
            Sign in with GitHub
          </Button>
        </CardContent>
      </Card>
       <p className="mt-8 text-center text-sm text-muted-foreground">
        By signing in, you agree to our (non-existent) Terms of Service.
      </p>
    </div>
  );
}
