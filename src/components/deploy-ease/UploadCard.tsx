
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
  type: 'log' | 'status' | 'error' | 'complete_event';
  payload: any;
  timestamp: Date;
}

interface DeploymentCompletionPayload {
  success: boolean;
  message: string;
  projectName?: string;
  deployedUrl?: string;
  error?: string;
}

export function UploadCard() {
  const [file, setFile] = useState<File | null>(null);
  const [githubUrl, setGithubUrl] = useState('');

  const [isProcessing, setIsProcessing] = useState(false);
  const [currentStatus, setCurrentStatus] = useState<string>('Awaiting input...');
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
      console.log("[CLIENT] Closing EventSource connection.");
      eventSourceRef.current.close();
      eventSourceRef.current = null;
    }
  }, []);

  // Ensure cleanup on component unmount
  useEffect(() => {
    return () => {
      console.log("[CLIENT] UploadCard unmounting, cleaning up EventSource.");
      cleanupEventSource();
    };
  }, [cleanupEventSource]);

  const resetDeploymentState = useCallback(() => {
    console.log("[CLIENT] Resetting deployment state.");
    cleanupEventSource(); 
    setFile(null);
    setGithubUrl('');
    if (fileInputRef.current) {
      fileInputRef.current.value = ""; 
    }
    setIsProcessing(false);
    setCurrentStatus('Awaiting input...');
    setLogs([]);
    setFinalResult(null);
  }, [cleanupEventSource]);

  const handleFileChange = (event: ChangeEvent<HTMLInputElement>) => {
    // Don't reset state if already processing
    if (isProcessing) return; 
    resetDeploymentState();
    const files = event.target.files;
    if (files && files[0]) {
      if (files[0].type === 'application/zip' || files[0].type === 'application/x-zip-compressed') {
        setFile(files[0]);
        setGithubUrl(''); // Clear URL if file is selected
      } else {
        toast({
          title: "Invalid File Type",
          description: "Please upload a ZIP file.",
          variant: "destructive",
        });
        setFile(null);
        if (fileInputRef.current) fileInputRef.current.value = "";
      }
    }
  };

  const handleUrlChange = (event: ChangeEvent<HTMLInputElement>) => {
    if (isProcessing) return;
    resetDeploymentState();
    setGithubUrl(event.target.value);
    if (event.target.value) { // If URL is entered, clear file
      setFile(null);
      if (fileInputRef.current) fileInputRef.current.value = "";
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

    // Full reset before new submission, ensures old EventSource is closed.
    resetDeploymentState(); 
    
    // Set processing state *after* reset
    setIsProcessing(true);
    setCurrentStatus('Initiating deployment...');
    setLogs([{ type: 'status', payload: 'Initiating deployment...', timestamp: new Date() }]);
    setFinalResult(null);


    const formData = new FormData();
    if (file) formData.append('zipfile', file);
    else if (githubUrl) formData.append('githubUrl', githubUrl);

    try {
      const initialResponse: InitialDeploymentResponse = await deployProject(formData);

      if (initialResponse.success && initialResponse.deploymentId) {
        setCurrentStatus('Deployment in progress...');
        setLogs(prev => [...prev, { type: 'status', payload: `Connecting to stream (ID: ${initialResponse.deploymentId})...`, timestamp: new Date() }]);

        // Ensure any old EventSource is closed before creating a new one
        cleanupEventSource(); 
        eventSourceRef.current = new EventSource(`/api/deploy-stream/${initialResponse.deploymentId}`);
        const es = eventSourceRef.current;

        es.onopen = () => {
          console.log(`[CLIENT] EventSource connection opened for ${initialResponse.deploymentId}.`);
          setLogs(prev => [...prev, {type: 'status', payload: 'Real-time log stream connected.', timestamp: new Date()}]);
          setCurrentStatus('Stream connected. Awaiting updates...');
        };

        es.addEventListener('log', (e) => {
          try {
            const logData = JSON.parse(e.data);
            setLogs(prev => [...prev, { type: 'log', payload: logData, timestamp: new Date() }]);
          } catch (parseError) {
            console.warn("[CLIENT] Failed to parse 'log' event data:", e.data, parseError);
            setLogs(prev => [...prev, { type: 'log', payload: `Malformed log data: ${e.data}`, timestamp: new Date() }]);
          }
        });

        es.addEventListener('status', (e) => {
          try {
            const statusData = JSON.parse(e.data);
            setCurrentStatus(statusData);
            // Optionally log status changes, can be verbose:
            // setLogs(prev => [...prev, { type: 'status', payload: statusData, timestamp: new Date() }]);
          } catch (parseError) {
            console.warn("[CLIENT] Failed to parse 'status' event data:", e.data, parseError);
            setCurrentStatus(`Malformed status: ${e.data.substring(0,50)}...`);
          }
        });

        es.addEventListener('complete', (e) => {
          console.log("[CLIENT] 'complete' event received.");
          let resultData: DeploymentCompletionPayload;
          try {
            resultData = JSON.parse(e.data);
          } catch (parseError) {
            console.error("[CLIENT] Failed to parse 'complete' event data:", e.data, parseError);
            resultData = { success: false, message: "Received malformed completion data from server.", error: String(e.data)};
          }

          setFinalResult(resultData);
          setCurrentStatus(resultData.success ? 'Deployment Completed' : 'Deployment Failed');
          setLogs(prev => [...prev, { type: 'complete_event', payload: resultData, timestamp: new Date() }]);
          toast({
            title: resultData.success ? "Deployment Successful" : "Deployment Failed",
            description: resultData.message,
            variant: resultData.success ? "default" : "destructive",
            duration: resultData.success ? 5000 : 9000,
          });
          cleanupEventSource();
          setIsProcessing(false); // Ensure processing is marked false
        });

        // Handles specific 'error' events sent by the server (e.g. stream termination due to server-side issue)
        es.addEventListener('error', (e: MessageEvent) => {
          console.warn("[CLIENT] SSE 'error' event received. Raw data:", e.data);
          let errorMessage = "An error occurred with the deployment stream.";
          let specificErrorFromServer = "";

          if (e.data && typeof e.data === 'string' && e.data.trim() !== "") {
            try {
              const errorData = JSON.parse(e.data);
              if (errorData && errorData.message && typeof errorData.message === 'string') {
                specificErrorFromServer = errorData.message;
                errorMessage = errorData.message;
              } else {
                specificErrorFromServer = e.data; 
                errorMessage = e.data; 
              }
            } catch (parseError: any) {
              specificErrorFromServer = e.data;
              errorMessage = e.data;
            }
          } else if (e.data) {
             specificErrorFromServer = String(e.data);
             errorMessage = String(e.data);
          }
          
          // Sanitize errorMessage for UI
          if (typeof errorMessage !== 'string') errorMessage = "Received non-string error data.";
          if (errorMessage.length > 250) errorMessage = errorMessage.substring(0, 247) + "...";
          if (errorMessage.startsWith("[object") && errorMessage.endsWith("]")) errorMessage = "Received complex object as error data.";
          if (errorMessage.trim() === "") errorMessage = "Received empty error message from server.";
          
          console.log("[CLIENT] Final error message for UI from 'error' event:", errorMessage);

          setLogs(prev => [...prev, { type: 'error', payload: `Stream Error: ${errorMessage}`, timestamp: new Date() }]);
          setCurrentStatus(`Stream Error: ${errorMessage.substring(0,60)}...`);
          toast({ title: "Stream Error", description: errorMessage, variant: "destructive", duration: 9000 });

          if (!finalResult) { // Only set finalResult if not already set by 'complete'
            setFinalResult({ success: false, message: errorMessage, error: specificErrorFromServer || "An error occurred with the deployment stream." });
          }
          cleanupEventSource();
          setIsProcessing(false);
        });

        // es.onerror for generic network/connection failures of the EventSource itself (e.g. server unavailable)
        es.onerror = (errorEvent) => {
          // This event is often of type Event, not MessageEvent, so errorEvent.data might not exist.
          console.error("[CLIENT] EventSource generic network error (es.onerror):", errorEvent);
          
          // Check if already handled by 'complete' or specific 'error' event from server
          if (eventSourceRef.current && !finalResult) { 
            const genericErrorMsg = 'Connection to deployment stream lost or server unavailable.';
            setLogs(prev => [...prev, { type: 'error', payload: genericErrorMsg, timestamp: new Date() }]);
            setCurrentStatus('Stream connection failed.');
            toast({ title: "Connection Error", description: genericErrorMsg, variant: "destructive", duration: 9000 });
            setFinalResult({ success: false, message: genericErrorMsg, error: "EventSource.onerror triggered" });
          }
          cleanupEventSource(); // Crucial: always cleanup
          setIsProcessing(false); // Crucial: always reset processing state
        };

      } else { // initialResponse.success is false or no deploymentId
        const message = initialResponse.message || "Unknown error during deployment initiation.";
        setCurrentStatus('Failed to initiate deployment.');
        setLogs(prev => [...prev, { type: 'error', payload: message, timestamp: new Date() }]);
        toast({ title: "Initiation Failed", description: message, variant: "destructive", duration: 9000 });
        setFinalResult({ success: false, message: message, error: message });
        setIsProcessing(false);
        cleanupEventSource(); // Ensure cleanup even if no ES was created
      }
    } catch (error) { // Catch errors from calling deployProject itself
      const errorMessage = error instanceof Error ? error.message : "An unexpected error occurred during initiation.";
      console.error("[CLIENT] handleSubmit critical error (calling deployProject action):", error);
      setCurrentStatus(`Initiation critically failed.`);
      setLogs(prev => [...prev, { type: 'error', payload: `Critical Error: ${errorMessage}`, timestamp: new Date() }]);
      toast({ title: "Deployment Initiation Critical Error", description: errorMessage, variant: "destructive", duration: 9000 });
      setFinalResult({ success: false, message: errorMessage, error: errorMessage });
      setIsProcessing(false);
      cleanupEventSource();
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
        {!isProcessing && !finalResult && (
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
                <Input id="githubUrl" type="url" placeholder="https://github.com/username/repository.git" value={githubUrl} onChange={handleUrlChange} disabled={!!file || isProcessing} className={file ? 'opacity-50 cursor-not-allowed' : ''} />
              </div>
              <p className="text-xs text-muted-foreground mt-1">Enter the URL of a public GitHub repository.</p>
            </div>

            <Button type="submit" className="w-full text-lg py-6" disabled={isProcessing || (!file && !githubUrl)}>
              {isProcessing ? <><Loader2 className="mr-2 h-5 w-5 animate-spin" /> Deploying...</> : "Deploy Project"}
            </Button>
          </form>
        )}

        {(isProcessing || logs.length > 0 || finalResult) && (
          <div className="mt-6 p-4 border rounded-lg bg-muted/50">
            <h3 className="text-xl font-semibold mb-3 flex items-center">
              <ListChecks className="h-6 w-6 text-primary mr-2" />
              Deployment Progress
            </h3>
            <p className="text-md mb-1 font-medium">
              Status: <span className={`${finalResult && !finalResult.success ? 'text-destructive' : 'text-primary'} font-semibold`}>
                {currentStatus}
              </span>
            </p>
            {isProcessing && !finalResult && <Loader2 className="my-2 h-5 w-5 animate-spin text-primary" />}
            
            <ScrollArea className="h-60 w-full rounded-md border bg-background p-3 text-sm mt-2">
              {logs.map((logItem, index) => (
                <div key={index} className="mb-1 font-mono leading-relaxed text-xs">
                  <span className="text-muted-foreground/60 mr-2 select-none">
                    [{logItem.timestamp.toLocaleTimeString()}]
                  </span>
                  <span className={
                    logItem.type === 'error' ? 'text-destructive' :
                    logItem.type === 'complete_event' && logItem.payload.success === false ? 'text-destructive' :
                    logItem.type === 'status' ? 'text-primary font-semibold' :
                    'text-foreground/80'
                  }>
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
            <div className="flex items-center mb-4">
              {finalResult.success ? <CheckCircle className="h-8 w-8 text-green-500 mr-3" /> : <XCircle className="h-8 w-8 text-red-500 mr-3" />}
              <h3 className="text-2xl font-semibold">
                Deployment {finalResult.success ? 'Successful' : 'Failed'}
              </h3>
            </div>
            <p className={`text-lg ${finalResult.success ? 'text-foreground' : 'text-destructive'}`}>
              {finalResult.message}
            </p>
            {finalResult.projectName && (
              <p className="mt-2 text-sm text-muted-foreground flex items-center">
                <FileText className="h-4 w-4 mr-2 text-muted-foreground" />
                Project: <span className="font-semibold ml-1 text-foreground">{finalResult.projectName}</span>
              </p>
            )}
            {finalResult.deployedUrl && finalResult.success && (
              <p className="mt-3">
                <a
                  href={finalResult.deployedUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-flex items-center text-primary hover:underline font-semibold text-lg"
                >
                  <LinkIcon className="h-5 w-5 mr-2" />
                  View Deployed Site
                </a>
                <span className="text-xs text-muted-foreground ml-2">(Note: S3 propagation might take a moment)</span>
              </p>
            )}
             <Button onClick={resetDeploymentState} className="mt-6 w-full text-lg py-3">
                Deploy Another Project
            </Button>
          </div>
        )}

      </CardContent>
      {!finalResult && !isProcessing && (
        <CardFooter>
          <p className="text-xs text-muted-foreground text-center w-full">
            Ready to deploy your project.
          </p>
        </CardFooter>
      )}
    </Card>
  );
}

    