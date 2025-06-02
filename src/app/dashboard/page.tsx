// src/app/dashboard/page.tsx
'use client';

// import { useEffect, useState } from 'react'; // useState might not be needed
// import { useRouter } from 'next/navigation';
// import { useAuth } from '@/contexts/AuthContext';
// import { Button } from '@/components/ui/button';
// import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
// import { Loader2, ShieldAlert, ListOrdered, ExternalLink, PlusCircle } from 'lucide-react';
// import Link from 'next/link';

import { UploadCard } from '@/components/deploy-ease/UploadCard';
import { Navbar } from '@/components/Navbar';

// interface DeployedProject { // No longer displaying projects here
//   id: string;
//   projectName: string;
//   deployedUrl: string;
//   createdAt: Date;
// }

export default function DashboardPage() {
  // const { currentUser, loading: authLoading, signOut } = useAuth(); // Removed
  // const router = useRouter(); // Removed
  // const [projects, setProjects] = useState<DeployedProject[]>([]); // Removed
  // const [loadingProjects, setLoadingProjects] = useState(true); // Removed

  // useEffect(() => { // Removed auth redirection and project fetching
  //   if (!authLoading && !currentUser) {
  //     router.push('/login');
  //   } else if (currentUser) {
  //     setLoadingProjects(false);
  //     setProjects([]);
  //   }
  // }, [currentUser, authLoading, router]);

  // if (authLoading || (!authLoading && !currentUser)) { // Removed loading state for auth check
  //   return (
  //     <div className="min-h-screen flex items-center justify-center p-4">
  //       <Loader2 className="h-12 w-12 animate-spin text-primary" />
  //       <p className="ml-4 text-lg">Loading dashboard...</p>
  //     </div>
  //   );
  // }

  return (
    <div className="min-h-screen w-full flex flex-col items-center bg-background pt-4 sm:pt-8 md:pt-12 p-4">
      <Navbar />
      <div className="flex flex-col items-center justify-center flex-grow w-full">
         <UploadCard />
      </div>
      {/* Removed all previous dashboard content */}
    </div>
  );
}
