// src/components/deploy-ease/UploadCard.tsx
'use client';

import React, { useState, useRef, ChangeEvent, useEffect, useCallback } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from '@/components/ui/card';
import { Label } from '@/components/ui/label';
import { useToast } from '@/hooks/use-toast';
import { deployProject, type InitialDeploymentResponse } from '@/app/actions';
import { UploadCloud, Loader2, CheckCircle, XCircle, FileText, Link as LinkIcon, Github, ListChecks } from 'lucide-react';
import { Separator } from '@/components/ui/separator';
import { ScrollArea } from '@/components/ui/scroll-area';

interface DeploymentLogEntry {
  type: 'log' | 'status' | 'error' | 'complete_event'; // 'complete_event' for the final event from SSE
  payload: any;
  timestamp: Date;
}

// Payload structure for the 'complete' SSE event
interface DeploymentCompletionPayload {
  success: boolean;
  message: string;
  projectName?: string;
  deployedUrl?: string;
  error?: string;
  logs?: string[]; // Optional: final full logs dump
}

export function UploadCard() {
  const [file, setFile] = useState<File | null>(null);
  const [githubUrl, setGithubUrl] = useState('');
  
  const [isProcessing, setIsProcessing] = useState(false); // True if initiating or streaming
  const [currentStatus, setCurrentStatus] = useState<string>('Awaiting deployment...');
  const [logs, setLogs] = useState<DeploymentLogEntry[]>([]);
  const [finalResult, setFinalResult] = useState<DeploymentCompletionPayload | null>(null);

  const fileInputRef = useRef<HTMLInputElement>(null);
  const eventSourceRef = useRef<EventSource | null>(null);
  const { toast } = useToast();
  const logsEndRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    logsEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [logs]);

  const cleanupEventSource = useCallback(() => {
    if (eventSourceRef.current) {
      eventSourceRef.current.close();
      eventSourceRef.current = null;
      // console.log("EventSource closed.");
    }
  }, []);

  useEffect(() => {
    return () => {
      cleanupEventSource(); // Cleanup on component unmount
    };
  }, [cleanupEventSource]);

  const resetDeploymentState = () => {
    setIsProcessing(false);
    setCurrentStatus('Awaiting deployment...');
    setLogs([]);
    setFinalResult(null);
    cleanupEventSource();
  };

  const handleFileChange = (event: ChangeEvent<HTMLInputElement>) => {
    const files = event.target.files;
    if (files && files[0]) {
      if (files[0].type === 'application/zip' || files[0].type === 'application/x-zip-compressed') {
        setFile(files[0]);
        setGithubUrl(''); 
        resetDeploymentState();
      } else {
        toast({
          title: "Invalid File Type",
          description: "Please upload a ZIP file.",
          variant: "destructive",
        });
        setFile(null);
        if (fileInputRef.current) {
          fileInputRef.current.value = "";
        }
      }
    }
  };

  const handleUrlChange = (event: ChangeEvent<HTMLInputElement>) => {
    setGithubUrl(event.target.value);
    if (event.target.value) {
      setFile(null); 
      if (fileInputRef.current) {
        fileInputRef.current.value = "";
      }
      resetDeploymentState();
    }
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

    resetDeploymentState();
    setIsProcessing(true);
    setCurrentStatus('Initiating deployment...');
    setLogs([{ type: 'status', payload: 'Initiating deployment...', timestamp: new Date() }]);

    const formData = new FormData();
    if (file) formData.append('zipfile', file);
    else if (githubUrl) formData.append('githubUrl', githubUrl);

    try {
      const initialResponse: InitialDeploymentResponse = await deployProject(formData);

      if (initialResponse.success && initialResponse.deploymentId) {
        setCurrentStatus('Deployment in progress...');
        setLogs(prev => [...prev, { type: 'status', payload: `Connecting to stream (ID: ${initialResponse.deploymentId})...`, timestamp: new Date() }]);
        
        const es = new EventSource(`/api/deploy-stream/${initialResponse.deploymentId}`);
        eventSourceRef.current = es;

        es.onopen = () => {
          // console.log("EventSource connection opened.");
          setLogs(prev => [...prev, {type: 'status', payload: 'Real-time log stream connected.', timestamp: new Date()}]);
        };

        es.addEventListener('log', (e) => {
          const logData = JSON.parse(e.data);
          setLogs(prev => [...prev, { type: 'log', payload: logData, timestamp: new Date() }]);
        });

        es.addEventListener('status', (e) => {
          const statusData = JSON.parse(e.data);
          setCurrentStatus(statusData);
          // Avoid duplicate status logs if they come from the log event too.
          // setLogs(prev => [...prev, { type: 'status', payload: statusData, timestamp: new Date() }]);
        });
        
        es.addEventListener('complete', (e) => {
          const resultData: DeploymentCompletionPayload = JSON.parse(e.data);
          setFinalResult(resultData);
          setCurrentStatus(resultData.success ? 'Deployment Completed' : 'Deployment Failed');
          setLogs(prev => [...prev, { type: 'complete_event', payload: resultData, timestamp: new Date() }]);
          toast({
            title: resultData.success ? "Deployment Successful" : "Deployment Failed",
            description: resultData.message,
            variant: resultData.success ? "default" : "destructive",
          });
          cleanupEventSource();
          setIsProcessing(false);
        });

        es.addEventListener('error', (e) => { // For specific errors sent by the server via SSE
          let errorMessage = "An error occurred with the deployment stream.";
           try {
            const errorData = JSON.parse(e.data); // SSE 'error' events might not have parsable data property
            if (errorData && errorData.message) errorMessage = errorData.message;
          } catch (parseError) { /* ignore if data is not JSON */ }

          setLogs(prev => [...prev, { type: 'error', payload: errorMessage, timestamp: new Date() }]);
          setCurrentStatus('Stream error or deployment issue.');
          toast({ title: "Stream Error", description: errorMessage, variant: "destructive" });
          cleanupEventSource();
          setIsProcessing(false);
          if (!finalResult) {
            setFinalResult({ success: false, message: errorMessage, error: errorMessage });
          }
        });

        es.onerror = (errorEvent) => { // For general EventSource connection failures
          console.error("EventSource failed:", errorEvent);
          setLogs(prev => [...prev, { type: 'error', payload: 'Connection to deployment stream lost or server error.', timestamp: new Date() }]);
          setCurrentStatus('Stream connection failed.');
          toast({ title: "Connection Error", description: "Lost connection to the deployment stream.", variant: "destructive" });
          cleanupEventSource();
          setIsProcessing(false); // Ensure processing state is updated
          if (!finalResult) { // Set final result if not already set by a 'complete' event
             setFinalResult({ success: false, message: "Connection to deployment stream lost or server error." });
          }
        };

      } else {
        // Initial call to deployProject action failed
        setCurrentStatus('Failed to initiate deployment.');
        const message = initialResponse.message || "Unknown initiation error.";
        setLogs(prev => [...prev, { type: 'error', payload: message, timestamp: new Date() }]);
        toast({ title: "Initiation Failed", description: message, variant: "destructive" });
        setFinalResult({ success: false, message: message });
        setIsProcessing(false);
      }
    } catch (error) {
      // Catch errors from the deployProject action call itself
      setIsProcessing(false);
      const errorMessage = error instanceof Error ? error.message : "An unexpected error occurred during initiation.";
      setCurrentStatus(`Initiation critically failed: ${errorMessage.substring(0,100)}`);
      setLogs(prev => [...prev, { type: 'error', payload: errorMessage, timestamp: new Date() }]);
      toast({ title: "Deployment Initiation Critical Error", description: errorMessage, variant: "destructive" });
      setFinalResult({ success: false, message: errorMessage });
      console.error("handleSubmit critical error:", error);
    }
  };


  return (
    <Card className="w-full max-w-2xl shadow-xl">
      <CardHeader>
        <CardTitle className="text-3xl font-headline text-center">DeployEase</CardTitle>
        <CardDescription className="text-center">
          Upload a ZIP or provide a GitHub URL for real-time deployment.
        </CardDescription>
      </CardHeader>
      <CardContent>
        {!finalResult && ( // Show form only if no final result yet
          <form onSubmit={handleSubmit} className="space-y-6">
            <div>
              <Label htmlFor="zipfile" className="text-lg font-medium">Upload Project ZIP File</Label>
              <div
                className={`mt-2 flex items-center justify-center w-full p-6 border-2 border-dashed rounded-lg transition-colors ${file ? 'border-primary' : 'hover:border-primary'} ${githubUrl || isProcessing ? 'opacity-50 cursor-not-allowed' : 'cursor-pointer'}`}
                onClick={() => !githubUrl && !isProcessing && fileInputRef.current?.click()}
              >
                <div className="text-center">
                  <UploadCloud className={`mx-auto h-12 w-12 ${file ? 'text-primary' : 'text-gray-400'}`} />
                  <p className="mt-2 text-sm text-muted-foreground"><span className="font-semibold">Click to upload</span> or D&D</p>
                  <p className="text-xs text-muted-foreground">ZIP files only</p>
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
                <Input id="githubUrl" type="url" placeholder="https://github.com/username/repository.git" value={githubUrl} onChange={handleUrlChange} disabled={!!file || isProcessing} className={file || isProcessing ? 'opacity-50 cursor-not-allowed' : ''} />
              </div>
              <p className="text-xs text-muted-foreground mt-1">Enter the URL of a public GitHub repository.</p>
            </div>

            <Button type="submit" className="w-full text-lg py-6" disabled={isProcessing || (!file && !githubUrl)}>
              {isProcessing ? (<><Loader2 className="mr-2 h-6 w-6 animate-spin" /> Deploying...</>) : ('Deploy Project')}
            </Button>
          </form>
        )}

        {(isProcessing || logs.length > 1 || finalResult) && ( // Show logs if processing, or if there's a result or more than initial log
          <div className="mt-6 p-4 border rounded-lg bg-muted/50">
            <h3 className="text-xl font-semibold mb-3 flex items-center">
              <ListChecks className="h-6 w-6 text-primary mr-2" />
              Deployment Progress
            </h3>
            <p className="text-md mb-3 font-medium">
              Status: <span className={`${finalResult && !finalResult.success ? 'text-destructive' : 'text-primary'} font-semibold`}>{currentStatus}</span>
            </p>
            <ScrollArea className="h-60 w-full rounded-md border bg-background p-3 text-sm">
              {logs.map((logItem, index) => (
                <div key={index} className="mb-1 font-mono leading-relaxed">
                  <span className="text-muted-foreground/60 mr-2 select-none">
                    [{logItem.timestamp.toLocaleTimeString()}]
                  </span>
                  <span className={
                    logItem.type === 'error' ? 'text-destructive' : 
                    logItem.type === 'complete_event' && logItem.payload.success === false ? 'text-destructive' :
                    logItem.type === 'status' ? 'text-primary font-semibold' : 
                    'text-foreground/80'
                  }>
                    {/* For 'complete_event', payload is an object, otherwise typically a string */}
                    {logItem.type === 'complete_event' ? `Event: ${logItem.payload.success ? 'Success' : 'Failure'} - ${logItem.payload.message}` : String(logItem.payload)}
                  </span>
                </div>
              ))}
              <div ref={logsEndRef} />
            </ScrollArea>
          </div>
        )}
        
        {finalResult && (
           <div className="mt-8 p-6 bg-card rounded-lg shadow border">
            <h3 className="text-xl font-semibold mb-4 flex items-center">
              {finalResult.success ? <CheckCircle className="h-6 w-6 text-green-500 mr-2" /> : <XCircle className="h-6 w-6 text-red-500 mr-2" />}
              Deployment {finalResult.success ? 'Successful' : 'Failed'}
            </h3>
            <p className={`text-lg ${finalResult.success ? 'text-foreground' : 'text-destructive font-semibold'}`}>
              {finalResult.message}
            </p>
            {finalResult.projectName && (
              <p className="mt-2 text-sm flex items-center">
                <FileText className="h-4 w-4 mr-2 text-primary" />
                Project Name: <span className="font-semibold ml-1">{finalResult.projectName}</span>
              </p>
            )}
            {finalResult.deployedUrl && finalResult.success && (
              <p className="mt-3 text-sm">
                <a
                  href={finalResult.deployedUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-flex items-center text-primary hover:underline font-semibold"
                >
                  <LinkIcon className="h-4 w-4 mr-2" />
                  View Deployed Site: {finalResult.deployedUrl}
                </a>
              </p>
            )}
             <Button onClick={() => {
                resetDeploymentState();
                setFile(null);
                setGithubUrl('');
                if (fileInputRef.current) fileInputRef.current.value = "";
             }} className="mt-6 w-full">
                Deploy Another Project
            </Button>
          </div>
        )}

      </CardContent>
      <CardFooter>
        <p className="text-xs text-muted-foreground text-center w-full">
          {isProcessing ? "Following real-time deployment steps..." : "Ready to deploy your project."}
        </p>
      </CardFooter>
    </Card>
  );
}
