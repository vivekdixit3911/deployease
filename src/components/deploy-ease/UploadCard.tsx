
// src/components/deploy-ease/UploadCard.tsx
'use client';

import React, { useState, useRef, ChangeEvent, useEffect } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from '@/components/ui/card';
import { Label } from '@/components/ui/label';
import { useToast } from '@/hooks/use-toast';
import { deployProject, type DeploymentResult } from '@/app/actions';
import { UploadCloud, Loader2, CheckCircle, XCircle, FileText, Link as LinkIcon, Github, ListChecks, AlertTriangle } from 'lucide-react';
import { Separator } from '@/components/ui/separator';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";

export function UploadCard() {
  const [file, setFile] = useState<File | null>(null);
  const [githubUrl, setGithubUrl] = useState('');
  const [isProcessing, setIsProcessing] = useState(false);
  const [deploymentResult, setDeploymentResult] = useState<DeploymentResult | null>(null);
  const [displayLogs, setDisplayLogs] = useState<string[]>([]);

  const fileInputRef = useRef<HTMLInputElement>(null);
  const { toast } = useToast();
  const logsEndRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (displayLogs.length > 0) {
        logsEndRef.current?.scrollIntoView({ behavior: "smooth" });
    }
  }, [displayLogs]);


  const resetState = () => {
    setFile(null);
    setGithubUrl('');
    if (fileInputRef.current) {
      fileInputRef.current.value = ""; 
    }
    setIsProcessing(false);
    setDeploymentResult(null);
    setDisplayLogs([]);
  };

  const handleFileChange = (event: ChangeEvent<HTMLInputElement>) => {
    if (isProcessing) return;
    // resetState(); // Don't reset fully here, allow URL to be cleared if file is chosen
    const files = event.target.files;
    if (files && files[0]) {
      // Basic check for .zip extension as MIME types can be unreliable
      if (files[0].name.toLowerCase().endsWith('.zip')) {
        setFile(files[0]);
        setGithubUrl(''); // Clear URL if file is selected
        setDeploymentResult(null); // Clear previous results
        setDisplayLogs([]);
      } else {
        toast({
          title: "Invalid File Type",
          description: "Please upload a .zip file.",
          variant: "destructive",
        });
        setFile(null);
        if (fileInputRef.current) fileInputRef.current.value = "";
      }
    }
  };

  const handleUrlChange = (event: ChangeEvent<HTMLInputElement>) => {
    if (isProcessing) return;
    // resetState(); // Don't reset fully here, allow file to be cleared if URL is typed
    setGithubUrl(event.target.value);
    if (event.target.value) { 
      setFile(null);
      if (fileInputRef.current) fileInputRef.current.value = "";
    }
    setDeploymentResult(null); // Clear previous results
    setDisplayLogs([]);
  };

  const handleSubmit = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!file && !githubUrl) {
      toast({ title: "No Input", description: "Please select a ZIP file or enter a GitHub URL.", variant: "destructive" });
      return;
    }
    if (githubUrl && !githubUrl.match(/^(https?:\/\/)?(www\.)?github\.com\/[\w-]+\/[\w.-]+(\.git)?$/i)) {
      toast({ title: "Invalid URL", description: "Please enter a valid GitHub repository URL.", variant: "destructive" });
      return;
    }
    
    setIsProcessing(true);
    setDeploymentResult(null);
    setDisplayLogs(['Initiating deployment...']);

    const formData = new FormData();
    if (file) {
      formData.append('zipfile', file);
      console.log("[CLIENT] Appending file to FormData:", file.name, file.type, file.size);
    } else if (githubUrl) {
      formData.append('githubUrl', githubUrl);
      console.log("[CLIENT] Appending githubUrl to FormData:", githubUrl);
    }

    try {
      const result = await deployProject(formData);
      setDeploymentResult(result);
      setDisplayLogs(prevLogs => [...prevLogs, ...(result.logs || []) , `Deployment ${result.success ? 'finished successfully.' : 'failed.'}`]);
      toast({
        title: result.success ? "Deployment Successful" : "Deployment Failed",
        description: result.message,
        variant: result.success ? "default" : "destructive",
        duration: result.success ? 5000 : 9000,
      });
    } catch (error) { // Catch errors from calling deployProject itself or network issues
      const errorMessage = error instanceof Error ? error.message : "An unexpected error occurred.";
      console.error("[CLIENT] handleSubmit critical error:", error);
      const resultWithError: DeploymentResult = {
        success: false,
        message: `Client-side error: ${errorMessage}`,
        error: errorMessage,
        logs: ['Critical client-side error during submission.', errorMessage]
      };
      setDeploymentResult(resultWithError);
      setDisplayLogs(prevLogs => [...prevLogs, ...resultWithError.logs || []]);
      toast({ title: "Deployment Submission Error", description: errorMessage, variant: "destructive", duration: 9000 });
    } finally {
      setIsProcessing(false);
    }
  };

  return (
    <Card className="w-full max-w-2xl shadow-xl">
      <CardHeader>
        <CardTitle className="text-3xl font-headline text-center">DeployEase</CardTitle>
        <CardDescription className="text-center">
          Upload a ZIP or provide a GitHub URL for deployment.
        </CardDescription>
      </CardHeader>
      <CardContent>
        {!isProcessing && !deploymentResult && (
          <form onSubmit={handleSubmit} className="space-y-6">
            <div>
              <Label htmlFor="zipfile" className="text-lg font-medium">Upload Project ZIP File</Label>
              <div
                className={`mt-2 flex items-center justify-center w-full p-6 border-2 border-dashed rounded-lg transition-colors ${file ? 'border-primary' : 'hover:border-primary'} ${githubUrl ? 'opacity-50 cursor-not-allowed' : 'cursor-pointer'}`}
                onClick={() => !githubUrl && !isProcessing && fileInputRef.current?.click()}
              >
                <div className="text-center">
                  <UploadCloud className={`mx-auto h-12 w-12 ${file ? 'text-primary' : 'text-gray-400'}`} />
                  <p className="mt-2 text-sm text-muted-foreground"><span className="font-semibold">Click to upload</span> or D&amp;D</p>
                  <p className="text-xs text-muted-foreground">.zip files only</p>
                  {file && <p className="text-sm text-primary mt-2">{file.name}</p>}
                </div>
              </div>
              <Input id="zipfile" type="file" accept=".zip,application/zip,application/x-zip-compressed" ref={fileInputRef} onChange={handleFileChange} className="hidden" disabled={!!githubUrl || isProcessing} />
            </div>

            <div className="flex items-center my-4"><Separator className="flex-grow" /><span className="mx-4 text-sm text-muted-foreground">OR</span><Separator className="flex-grow" /></div>

            <div>
              <Label htmlFor="githubUrl" className="text-lg font-medium">Import from GitHub Repository</Label>
              <div className="mt-2 flex items-center space-x-2">
                <Github className={`h-6 w-6 ${githubUrl ? 'text-primary' : 'text-gray-400'}`} />
                <Input id="githubUrl" type="url" placeholder="https://github.com/username/repository.git" value={githubUrl} onChange={handleUrlChange} disabled={!!file || isProcessing} className={file ? 'opacity-50 cursor-not-allowed' : ''} />
              </div>
              <p className="text-xs text-muted-foreground mt-1">Enter the URL of a public GitHub repository.</p>
            </div>

            <Button type="submit" className="w-full text-lg py-6" disabled={isProcessing || (!file && !githubUrl)}>
              Deploy Project
            </Button>
          </form>
        )}
        
        {(isProcessing || deploymentResult) && (
          <div className="mt-6">
            {isProcessing && !deploymentResult && (
              <div className="flex flex-col items-center justify-center p-6 border rounded-lg bg-muted/50">
                <Loader2 className="h-12 w-12 animate-spin text-primary mb-4" />
                <p className="text-lg font-semibold text-primary">Deployment in progress...</p>
                <p className="text-sm text-muted-foreground">Please wait while your project is being deployed.</p>
              </div>
            )}

            {deploymentResult && (
              <div className={`mt-4 p-4 border rounded-lg ${deploymentResult.success ? 'bg-green-50 border-green-200' : 'bg-red-50 border-red-200'}`}>
                <div className="flex items-center mb-3">
                  {deploymentResult.success ? <CheckCircle className="h-8 w-8 text-green-600 mr-3" /> : <XCircle className="h-8 w-8 text-red-600 mr-3" />}
                  <h3 className={`text-2xl font-semibold ${deploymentResult.success ? 'text-green-700' : 'text-red-700'}`}>
                    Deployment {deploymentResult.success ? 'Successful' : 'Failed'}
                  </h3>
                </div>
                <p className={`text-md ${deploymentResult.success ? 'text-green-700' : 'text-red-700'}`}>
                  {deploymentResult.message}
                </p>
                {deploymentResult.projectName && (
                  <p className="mt-1 text-sm text-muted-foreground">
                    <FileText className="h-4 w-4 mr-1 inline-block" />
                    Project: <span className="font-semibold">{deploymentResult.projectName}</span>
                  </p>
                )}
                {deploymentResult.deployedUrl && deploymentResult.success && (
                  <p className="mt-2">
                    <a
                      href={deploymentResult.deployedUrl}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="inline-flex items-center text-primary hover:underline font-semibold"
                    >
                      <LinkIcon className="h-4 w-4 mr-1" />
                      View Deployed Site
                    </a>
                     <span className="text-xs text-muted-foreground ml-2">(Note: S3 propagation might take a moment)</span>
                  </p>
                )}
                 {!deploymentResult.success && deploymentResult.error && (
                  <Alert variant="destructive" className="mt-4">
                    <AlertTriangle className="h-4 w-4" />
                    <AlertTitle>Error Details</AlertTitle>
                    <AlertDescription>
                      <pre className="whitespace-pre-wrap text-xs">{deploymentResult.error}</pre>
                    </AlertDescription>
                  </Alert>
                )}
              </div>
            )}
            
            {(displayLogs.length > 0 || (deploymentResult && deploymentResult.logs && deploymentResult.logs.length > 0)) && (
                 <div className="mt-6 p-4 border rounded-lg bg-muted/50">
                    <h3 className="text-lg font-semibold mb-2 flex items-center">
                        <ListChecks className="h-5 w-5 text-primary mr-2" />
                        Deployment Logs
                    </h3>
                    <ScrollArea className="h-60 w-full rounded-md border bg-background p-3 text-sm">
                    {(deploymentResult?.logs || displayLogs).map((log, index) => (
                        <div key={index} className="font-mono text-xs mb-1">
                           {log.startsWith('---') ? <Separator className="my-2" /> : null}
                           {log}
                           {log.startsWith('---') ? <Separator className="my-2" /> : null}
                        </div>
                    ))}
                    <div ref={logsEndRef} />
                    </ScrollArea>
                </div>
            )}

            {(isProcessing || deploymentResult) && (
              <Button onClick={resetState} className="mt-6 w-full text-lg py-3">
                Deploy Another Project
              </Button>
            )}
          </div>
        )}
      </CardContent>
      {!isProcessing && !deploymentResult && (
        <CardFooter>
          <p className="text-xs text-muted-foreground text-center w-full">
            Ready to deploy your project.
          </p>
        </CardFooter>
      )}
    </Card>
  );
}
