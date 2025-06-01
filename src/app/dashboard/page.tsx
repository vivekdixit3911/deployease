// src/app/dashboard/page.tsx
'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useAuth } from '@/contexts/AuthContext';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Loader2, ShieldAlert, ListOrdered, ExternalLink, PlusCircle } from 'lucide-react';
import Link from 'next/link';

// Placeholder type for project data - replace with actual Firestore data structure
interface DeployedProject {
  id: string;
  projectName: string;
  deployedUrl: string;
  createdAt: Date; // Or Firebase Timestamp
}

export default function DashboardPage() {
  const { currentUser, loading: authLoading, signOut } = useAuth();
  const router = useRouter();
  const [projects, setProjects] = useState<DeployedProject[]>([]);
  const [loadingProjects, setLoadingProjects] = useState(true);

  useEffect(() => {
    if (!authLoading && !currentUser) {
      router.push('/login');
    } else if (currentUser) {
      // TODO: Fetch projects for the current user from Firestore
      // For now, using placeholder data or indicating no projects
      // Example:
      // const fetchProjects = async () => {
      //   setLoadingProjects(true);
      //   // const userProjects = await getProjectsForUser(currentUser.uid); // Implement this
      //   // setProjects(userProjects);
      //   setProjects([]); // Placeholder
      //   setLoadingProjects(false);
      // };
      // fetchProjects();
      setLoadingProjects(false); // Simulate loading finished
       // Placeholder projects for demonstration
      const placeholderProjects = [
        { id: '1', projectName: 'my-first-app', deployedUrl: `/sites/users/${currentUser.uid}/sites/my-first-app/`, createdAt: new Date() },
        { id: '2', projectName: 'another-cool-site', deployedUrl: `/sites/users/${currentUser.uid}/sites/another-cool-site/`, createdAt: new Date(Date.now() - 86400000) }, // Yesterday
      ];
      // To use actual user ID in placeholder:
      // setProjects(currentUser.uid === 'default-user' ? placeholderProjects : []);
      setProjects([]); // Start with no projects until Firestore is integrated
    }
  }, [currentUser, authLoading, router]);

  if (authLoading || (!authLoading && !currentUser)) {
    return (
      <div className="min-h-screen flex items-center justify-center p-4">
        <Loader2 className="h-12 w-12 animate-spin text-primary" />
        <p className="ml-4 text-lg">Loading dashboard...</p>
      </div>
    );
  }

  return (
    <div className="container mx-auto py-8 px-4 sm:px-6 lg:px-8">
      <div className="flex flex-col sm:flex-row justify-between items-center mb-8 gap-4">
        <div>
          <h1 className="text-3xl font-bold tracking-tight text-primary">Your Dashboard</h1>
          <p className="text-muted-foreground">
            Welcome back, {currentUser?.displayName || currentUser?.email}! Manage your deployments here.
          </p>
        </div>
        <Button asChild>
          <Link href="/" className="flex items-center">
            <PlusCircle className="h-5 w-5 mr-2" />
            Deploy New Project
          </Link>
        </Button>
      </div>

      <Card className="shadow-lg">
        <CardHeader>
          <CardTitle className="flex items-center">
            <ListOrdered className="h-6 w-6 mr-2 text-primary" />
            My Deployed Projects
          </CardTitle>
          <CardDescription>
            Here are the projects you have deployed using DeployEase.
            {/* This will be populated once Firestore integration is complete. */}
          </CardDescription>
        </CardHeader>
        <CardContent>
          {loadingProjects ? (
            <div className="text-center py-10">
              <Loader2 className="h-8 w-8 animate-spin text-primary mx-auto mb-2" />
              <p>Loading your projects...</p>
            </div>
          ) : projects.length === 0 ? (
            <div className="text-center py-10 px-6 bg-muted/30 rounded-lg">
              <ShieldAlert className="h-12 w-12 text-primary mx-auto mb-3" />
              <h3 className="text-xl font-semibold mb-2">No Projects Yet!</h3>
              <p className="text-muted-foreground mb-4">
                You haven&apos;t deployed any projects. Click the button below to get started.
              </p>
              <Button asChild>
                <Link href="/">Deploy Your First Project</Link>
              </Button>
            </div>
          ) : (
            <ul className="space-y-4">
              {projects.map((project) => (
                <li key={project.id} className="p-4 border rounded-lg hover:shadow-md transition-shadow flex flex-col sm:flex-row justify-between items-start sm:items-center gap-3">
                  <div>
                    <h3 className="text-lg font-semibold text-primary">{project.projectName}</h3>
                    <p className="text-sm text-muted-foreground">
                      Deployed on: {new Date(project.createdAt).toLocaleDateString()}
                    </p>
                  </div>
                  <Button variant="outline" size="sm" asChild>
                    <a href={project.deployedUrl} target="_blank" rel="noopener noreferrer" className="flex items-center">
                      View Site
                      <ExternalLink className="h-4 w-4 ml-2" />
                    </a>
                  </Button>
                </li>
              ))}
            </ul>
          )}
          <div className="mt-6 text-sm text-center text-muted-foreground">
             Note: Project listing currently uses placeholder data. Actual project data will appear after Firestore integration.
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
