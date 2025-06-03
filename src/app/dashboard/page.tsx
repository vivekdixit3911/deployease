// src/app/dashboard/page.tsx
'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import type { User } from 'firebase/auth'; // Import User type
import { useAuth } from '@/contexts/AuthContext';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from '@/components/ui/card';
import { Loader2, ExternalLink, PlusCircle, ListOrdered, Server, CalendarDays, Globe, LogOut } from 'lucide-react';
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { UploadCard } from '@/components/deploy-ease/UploadCard';
import { db } from '@/lib/firebase';
import { collection, query, orderBy, getDocs, Timestamp } from 'firebase/firestore';
import { formatDistanceToNow } from 'date-fns';


interface DeployedProject {
  id: string; // Firestore document ID (deploymentId)
  projectName: string;
  deployedUrl: string;
  s3Path: string;
  framework: string;
  createdAt: Date; // Converted from Firestore Timestamp
}

export default function DashboardPage() {
  const { currentUser, signOut, loading: authLoading } = useAuth();
  const router = useRouter();
  const [projects, setProjects] = useState<DeployedProject[]>([]);
  const [loadingProjects, setLoadingProjects] = useState(true);

  const getInitials = (name: string | null | undefined) => {
    if (!name) return 'U';
    const names = name.split(' ');
    if (names.length > 1) {
      return `${names[0][0]}${names[names.length - 1][0]}`.toUpperCase();
    }
    return name[0].toUpperCase();
  };

  const handleSignOut = async () => {
    await signOut();
    router.push('/login');
  };

  useEffect(() => {
    if (!authLoading && !currentUser) {
      router.push('/login');
    } else if (currentUser) {
      const fetchProjects = async () => {
        if (!db) {
          console.error("Firestore DB instance not available for fetching projects.");
          setLoadingProjects(false);
          return;
        }
        try {
          setLoadingProjects(true);
          const projectsColRef = collection(db, `users/${currentUser.uid}/projects`);
          const q = query(projectsColRef, orderBy('createdAt', 'desc'));
          const querySnapshot = await getDocs(q);
          const userProjects = querySnapshot.docs.map(doc => {
            const data = doc.data();
            return {
              id: doc.id,
              projectName: data.projectName,
              deployedUrl: data.deployedUrl,
              s3Path: data.s3Path,
              framework: data.framework || 'unknown',
              createdAt: (data.createdAt as Timestamp).toDate(), // Convert Firestore Timestamp to JS Date
            };
          });
          setProjects(userProjects);
        } catch (error) {
          console.error("Error fetching projects:", error);
          // Optionally, show a toast to the user
        } finally {
          setLoadingProjects(false);
        }
      };
      fetchProjects();
    }
  }, [currentUser, authLoading, router]);

  if (authLoading || (!currentUser && !authLoading)) {
    return (
      <div className="min-h-screen w-full flex flex-col items-center justify-center bg-background p-4">
        <div className="absolute top-4 right-4">
          <Loader2 className="h-6 w-6 animate-spin text-primary" />
        </div>
        <div className="flex-grow flex flex-col items-center justify-center">
          <Loader2 className="h-12 w-12 animate-spin text-primary" />
          <p className="ml-4 text-lg text-muted-foreground">Loading dashboard...</p>
        </div>
      </div>
    );
  }
  
  // The error occurs on the next line, where the main div starts
  return (
    <div className="min-h-screen w-full flex flex-col items-center bg-background pt-4 sm:pt-8 md:pt-12 p-4">
      <h1>Dashboard Test Page</h1>
      <p>If this builds, the error is in the commented out content below.</p>
      
      {/* {currentUser && (
         <div className="absolute top-4 right-4 sm:top-6 sm:right-6 md:top-8 md:right-8 z-50">
           <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="ghost" className="relative h-10 w-10 rounded-full">
                <Avatar className="h-10 w-10 border-2 border-primary/50">
                  <AvatarImage src={currentUser.photoURL || undefined} alt={currentUser.displayName || "User"} />
                  <AvatarFallback>{getInitials(currentUser.displayName)}</AvatarFallback>
                </Avatar>
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent className="w-56" align="end" forceMount>
              <DropdownMenuLabel className="font-normal">
                <div className="flex flex-col space-y-1">
                  <p className="text-sm font-medium leading-none">{currentUser.displayName || "User"}</p>
                  <p className="text-xs leading-none text-muted-foreground">
                    {currentUser.email}
                  </p>
                </div>
              </DropdownMenuLabel>
              <DropdownMenuSeparator />
              <DropdownMenuItem onClick={handleSignOut} className="cursor-pointer">
                <LogOut className="mr-2 h-4 w-4" />
                <span>Sign Out</span>
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      )}
      <div className="container mx-auto px-4 py-8">
        <div className="mb-10">
          <h2 className="text-3xl font-bold tracking-tight mb-2 text-center sm:text-left">Deploy New Project</h2>
           <UploadCard />
        </div>
        
        <div className="mt-12">
          <h2 className="text-3xl font-bold tracking-tight mb-6 text-center sm:text-left flex items-center">
            <ListOrdered className="mr-3 h-8 w-8 text-primary" />
            Your Deployed Projects
          </h2>
          {loadingProjects ? (
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
              {[1,2,3].map(i => (
                <Card key={i} className="shadow-lg animate-pulse">
                  <CardHeader>
                    <div className="h-6 bg-muted rounded w-3/4"></div>
                    <div className="h-4 bg-muted rounded w-1/2 mt-2"></div>
                  </CardHeader>
                  <CardContent>
                    <div className="h-4 bg-muted rounded w-full mb-2"></div>
                    <div className="h-4 bg-muted rounded w-5/6"></div>
                  </CardContent>
                  <CardFooter>
                    <div className="h-8 bg-muted rounded w-1/3"></div>
                  </CardFooter>
                </Card>
              ))}
            </div>
          ) : projects.length === 0 ? (
            <Card className="shadow-lg text-center py-12">
              <CardContent>
                <Server className="h-16 w-16 text-muted-foreground mx-auto mb-4" />
                <p className="text-xl font-semibold text-muted-foreground">No projects deployed yet.</p>
                <p className="text-sm text-muted-foreground mt-2">Use the form above to deploy your first project!</p>
              </CardContent>
            </Card>
          ) : (
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
              {projects.map((project) => (
                <Card key={project.id} className="shadow-lg hover:shadow-xl transition-shadow duration-300 flex flex-col">
                  <CardHeader>
                    <CardTitle className="text-2xl truncate">{project.projectName}</CardTitle>
                    <CardDescription className="flex items-center text-sm">
                       <Globe className="h-4 w-4 mr-1.5 text-sky-500" /> Type: {project.framework || 'Static'}
                    </CardDescription>
                  </CardHeader>
                  <CardContent className="flex-grow">
                     <p className="text-sm text-muted-foreground flex items-center mb-1">
                      <CalendarDays className="h-4 w-4 mr-1.5 text-primary/80" />
                      Deployed: {formatDistanceToNow(project.createdAt, { addSuffix: true })}
                    </p>
                    <p className="text-sm text-muted-foreground truncate">
                       S3 Path: <span className="font-mono text-xs">{project.s3Path}</span>
                    </p>
                  </CardContent>
                  <CardFooter>
                    <Button asChild variant="default" size="sm" className="w-full">
                      <a href={project.deployedUrl} target="_blank" rel="noopener noreferrer" className="flex items-center">
                        <ExternalLink className="h-4 w-4 mr-2" />
                        View Site
                      </a>
                    </Button>
                  </CardFooter>
                </Card>
              ))}
            </div>
          )}
        </div>
         <div className="mt-16 text-center">
            {/* This button could be removed or repurposed if not needed, or styled as primary action */}
            {/* <Button variant="outline" onClick={() => { /* Reset UploadCard or scroll to top */ }} className="text-lg py-6 px-8">
            //     <PlusCircle className="mr-2 h-5 w-5" /> Deploy Another Project
            // </Button> */}
        //</div>
      //</div> */}
    </div>
  );
}

