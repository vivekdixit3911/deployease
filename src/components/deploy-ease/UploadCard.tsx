// src/components/deploy-ease/UploadCard.tsx
'use client';

import React, { useState, useRef, ChangeEvent } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from '@/components/ui/card';
import { Label } from '@/components/ui/label';
import { useToast } from '@/hooks/use-toast';
import { deployProject } from '@/app/actions';
import { UploadCloud, Loader2, CheckCircle, XCircle, FileText, Link as LinkIcon } from 'lucide-react'; // Removed Zap icon
import { Progress } from '@/components/ui/progress'; 

interface DeploymentStatus {
  projectName?: string;
  // framework?: string; // Framework info no longer shown in UI
  deployedUrl?: string;
  logs?: string;
  message: string;
}

export function UploadCard() {
  const [file, setFile] = useState<File | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [status, setStatus] = useState<DeploymentStatus | null>(null);
  const [progress, setProgress] = useState(0); 
  const fileInputRef = useRef<HTMLInputElement>(null);
  const { toast } = useToast();

  const handleFileChange = (event: ChangeEvent<HTMLInputElement>) => {
    const files = event.target.files;
    if (files && files[0]) {
      if (files[0].type === 'application/zip' || files[0].type === 'application/x-zip-compressed') {
        setFile(files[0]);
        setStatus(null); // Reset status on new file selection
        setProgress(0); // Reset progress
      } else {
        toast({
          title: "Invalid File Type",
          description: "Please upload a ZIP file.",
          variant: "destructive",
        });
        setFile(null);
        if (fileInputRef.current) {
          fileInputRef.current.value = ""; // Reset file input
        }
      }
    }
  };

  const handleSubmit = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!file) {
      toast({
        title: "No File Selected",
        description: "Please select a ZIP file to deploy.",
        variant: "destructive",
      });
      return;
    }

    setIsLoading(true);
    setProgress(10); 
    setStatus({ message: "Uploading and processing..." });

    const formData = new FormData();
    formData.append('zipfile', file);

    
    const progressInterval = setInterval(() => {
      setProgress(prev => (prev < 80 ? prev + 5 : (prev < 95 ? prev + 1 : prev))); // Slower progress towards the end
    }, 300);

    try {
      const result = await deployProject(formData);
    
      clearInterval(progressInterval);
      setProgress(100);
      setIsLoading(false);
      setStatus({
        message: result.message,
        projectName: result.projectName,
        // framework: result.framework, // No longer setting framework for UI
        deployedUrl: result.deployedUrl,
        logs: result.logs,
      });

      if (result.success) {
        toast({
          title: "Deployment Successful",
          description: result.message,
        });
      } else {
        toast({
          title: "Deployment Failed",
          description: result.message || "An unknown error occurred during deployment.",
          variant: "destructive",
        });
      }
    } catch (error) {
      clearInterval(progressInterval);
      setProgress(100); // Mark as complete even on error
      setIsLoading(false);
      const errorMessage = error instanceof Error ? error.message : "An unexpected error occurred.";
      setStatus({
        message: `Deployment failed: ${errorMessage}`,
        logs: status?.logs // Preserve existing logs if any
      });
      toast({
        title: "Deployment Error",
        description: errorMessage,
        variant: "destructive",
      });
      console.error("Deployment handleSubmit error:", error);
    }
  };

  return (
    <Card className="w-full max-w-2xl shadow-xl">
      <CardHeader>
        <CardTitle className="text-3xl font-headline text-center">Deploy Your Project</CardTitle>
        <CardDescription className="text-center">
          Upload a ZIP file of your web project. We&apos;ll handle the rest!
        </CardDescription>
      </CardHeader>
      <CardContent>
        <form onSubmit={handleSubmit} className="space-y-6">
          <div className="space-y-2">
            <Label htmlFor="zipfile" className="text-lg">Project ZIP File</Label>
            <div 
              className="flex items-center justify-center w-full p-6 border-2 border-dashed rounded-lg cursor-pointer hover:border-primary transition-colors"
              onClick={() => fileInputRef.current?.click()}
            >
              <div className="text-center">
                <UploadCloud className="mx-auto h-12 w-12 text-gray-400" />
                <p className="mt-2 text-sm text-muted-foreground">
                  <span className="font-semibold">Click to upload</span> or drag and drop
                </p>
                <p className="text-xs text-muted-foreground">ZIP files only</p>
                {file && <p className="text-sm text-primary mt-2">{file.name}</p>}
              </div>
            </div>
            <Input
              id="zipfile"
              type="file"
              accept=".zip,application/zip,application/x-zip-compressed"
              ref={fileInputRef}
              onChange={handleFileChange}
              className="hidden" 
            />
          </div>
          <Button type="submit" className="w-full text-lg py-6" disabled={isLoading || !file}>
            {isLoading ? (
              <>
                <Loader2 className="mr-2 h-6 w-6 animate-spin" />
                Deploying...
              </>
            ) : (
              'Upload & Deploy'
            )}
          </Button>
        </form>

        {isLoading && progress > 0 && (
          <div className="mt-6">
            <Progress value={progress} className="w-full" />
            <p className="text-sm text-center text-muted-foreground mt-2">{status?.message || "Processing..."}</p>
          </div>
        )}

        {status && !isLoading && (
          <div className="mt-8 p-6 bg-card rounded-lg shadow border">
            <h3 className="text-xl font-semibold mb-4 flex items-center">
              {status.projectName || status.deployedUrl ? <CheckCircle className="h-6 w-6 text-green-500 mr-2" /> : <XCircle className="h-6 w-6 text-red-500 mr-2" />}
              Deployment Status
            </h3>
            <p className={`text-lg ${status.projectName || status.deployedUrl ? 'text-foreground' : 'text-destructive-foreground'}`}>
              {status.message}
            </p>
            {status.projectName && (
              <p className="mt-2 text-sm flex items-center">
                <FileText className="h-4 w-4 mr-2 text-primary" />
                Project Name: <span className="font-semibold ml-1">{status.projectName}</span>
              </p>
            )}
            {/* Framework display removed from here */}
            {status.deployedUrl && (
              <p className="mt-3 text-sm">
                <a
                  href={status.deployedUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-flex items-center text-primary hover:underline font-semibold"
                >
                  <LinkIcon className="h-4 w-4 mr-2" />
                  View Deployed Site: {status.deployedUrl}
                </a>
              </p>
            )}
            {status.logs && (
              <details className="mt-4">
                <summary className="cursor-pointer text-sm text-muted-foreground hover:text-foreground">View Logs</summary>
                <pre className="mt-2 p-3 bg-muted rounded-md text-xs overflow-x-auto max-h-60 border">
                  {status.logs}
                </pre>
              </details>
            )}
          </div>
        )}
      </CardContent>
      <CardFooter>
        <p className="text-xs text-muted-foreground text-center w-full">
          The system automatically detects frameworks to process your project.
        </p>
      </CardFooter>
    </Card>
  );
}

