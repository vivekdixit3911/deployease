// src/app/login/page.tsx
'use client';

// Auth-related imports are removed for temporary bypass
// import { useEffect } from 'react';
// import { useRouter } from 'next/navigation';
// import { signInWithPopup, type AuthProvider as FirebaseAuthProvider } from 'firebase/auth';
// import { auth, googleProvider, githubProvider, firebaseConfig } from '@/lib/firebase';
// import { useAuth } from '@/contexts/AuthContext';
// import { Button } from '@/components/ui/button';
// import { Chrome, GithubIcon, Loader2 } from 'lucide-react';
// import { useToast } from '@/hooks/use-toast';

import { UploadCard } from '@/components/deploy-ease/UploadCard';
import { Navbar } from '@/components/Navbar';

export default function LoginPage() {
  // const { currentUser, loading } = useAuth(); // Removed
  // const router = useRouter(); // Removed
  // const { toast } = useToast(); // Removed

  // useEffect(() => { // Removed auth redirection
  //   if (!loading && currentUser) {
  //     router.push('/dashboard');
  //   }
  // }, [currentUser, loading, router]);

  // const handleSignIn = async (provider: FirebaseAuthProvider) => { ... }; // Removed

  // if (loading || (!loading && currentUser)) { // Removed loading/redirect state
  //   return (
  //     <div className="min-h-screen w-full flex flex-col items-center justify-center bg-black p-4 text-center relative">
  //       <Loader2 className="h-16 w-16 animate-spin mb-6 text-white" />
  //       <p className="text-xl text-white">Loading session...</p>
  //     </div>
  //   );
  // }

  return (
    <div className="min-h-screen w-full flex flex-col items-center bg-background pt-4 sm:pt-8 md:pt-12 p-4">
      <Navbar />
      <div className="flex flex-col items-center justify-center flex-grow w-full">
        {/* <h1 // Title can be part of UploadCard or added separately if needed
          className="text-7xl sm:text-8xl md:text-9xl font-bold tracking-tight mb-12 animate-fadeIn animated-gradient-text-fill"
          data-text="DeployEase"
        >
          DeployEase
        </h1> */}
        <UploadCard />
      </div>
       {/* Removed style jsx global for fadeIn */}
    </div>
  );
}
