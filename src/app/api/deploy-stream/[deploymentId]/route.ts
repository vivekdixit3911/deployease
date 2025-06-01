
// src/app/api/deploy-stream/[deploymentId]/route.ts
import { type NextRequest, NextResponse } from 'next/server';
import { getDeploymentState, type DeploymentProgress } from '@/lib/deploymentStore';

export const dynamic = 'force-dynamic'; // Ensures this route is not cached

const POLLING_INTERVAL = 750; // ms

export async function GET(
  request: NextRequest,
  { params }: { params: { deploymentId: string } }
) {
  const { deploymentId } = params;
  const sseLogPrefix = `[SSE Stream:${deploymentId || 'NO_ID'}]`;

  if (!deploymentId) {
    console.error(`${sseLogPrefix} Critical: Missing deploymentId in request params.`);
    return NextResponse.json({ error: 'Missing deploymentId in request parameters.' }, { 
        status: 400, 
        headers: { 'Content-Type': 'application/json', 'Connection': 'close' } 
    });
  }
  console.log(`${sseLogPrefix} Connection attempt received.`);

  const initialDeploymentState = getDeploymentState(deploymentId);
  if (!initialDeploymentState) {
    console.warn(`${sseLogPrefix} Invalid or expired deployment ID. Deployment state not found.`);
    return NextResponse.json({ error: `Deployment ID '${deploymentId}' not found or has expired.` }, { 
      status: 404, 
      headers: { 'Content-Type': 'application/json', 'Connection': 'close' } 
    });
  }
  console.log(`${sseLogPrefix} Deployment ID validated. Project: ${initialDeploymentState.projectName || 'N/A'}. Preparing stream.`);

  const stream = new ReadableStream({
    async start(controller) {
      console.log(`${sseLogPrefix} Stream controller 'start' method invoked.`);
      let lastLogIndex = 0;
      let lastStatus = ''; // Will be set from initial state
      let clientClosed = false;
      let pollerIntervalId: NodeJS.Timeout | null = null;

      const safeEnqueue = (event: string, data: any): boolean => {
        if (clientClosed) {
          // console.log(`${sseLogPrefix} safeEnqueue: Client closed. Skipping event '${event}'.`);
          return false;
        }
        // Check if controller is still usable.
        if (controller.desiredSize === null || controller.desiredSize <= 0) {
            console.warn(`${sseLogPrefix} safeEnqueue: Controller desiredSize is ${controller.desiredSize}. Assuming client closed or stream broke. Skipping event '${event}'.`);
            // Aggressively mark clientClosed, cleanup will handle the rest
            if (!clientClosed) cleanup(); 
            return false;
        }
        try {
          controller.enqueue(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
          // console.log(`${sseLogPrefix} Enqueued event: ${event}`);
          return true;
        } catch (e: any) {
          console.error(`${sseLogPrefix} safeEnqueue: Error enqueuing data for event '${event}': ${e.message}. Marking client as closed.`);
          if (!clientClosed) cleanup(); // Ensure cleanup on enqueue error
          return false;
        }
      };

      const cleanup = () => {
        if (clientClosed) {
          // console.log(`${sseLogPrefix} Cleanup already performed or in progress.`);
          return;
        }
        clientClosed = true; 
        console.log(`${sseLogPrefix} Cleanup invoked.`);

        if (pollerIntervalId) {
          clearInterval(pollerIntervalId);
          pollerIntervalId = null;
          console.log(`${sseLogPrefix} Poller interval cleared.`);
        }
        
        // Only try to close if controller seems active (desiredSize not null)
        if (controller.desiredSize !== null) { 
          try {
            controller.close();
            console.log(`${sseLogPrefix} Stream controller closed.`);
          } catch (e:any) {
            // This can happen if already closed or in a bad state, usually safe to ignore
            console.warn(`${sseLogPrefix} Error closing controller during cleanup: ${e.message}. (May be normal if already closed)`);
          }
        }
      };
      
      // Re-fetch state in case it changed between the initial check and stream start
      const currentInitialStateForStream = getDeploymentState(deploymentId);
      if (!currentInitialStateForStream) {
        console.warn(`${sseLogPrefix} Initial deployment state disappeared before stream could fully start. Sending error and closing.`);
        safeEnqueue('error', { message: "Deployment state disappeared unexpectedly. Stream closing." });
        cleanup();
        return; // Don't start poller
      }

      // Send initial state immediately
      safeEnqueue('status', currentInitialStateForStream.status);
      lastStatus = currentInitialStateForStream.status;
      currentInitialStateForStream.logs.forEach(log => safeEnqueue('log', log));
      lastLogIndex = currentInitialStateForStream.logs.length;
      
      if (currentInitialStateForStream.isDone) {
          console.log(`${sseLogPrefix} Deployment was already complete at stream start. Sending 'complete' event and closing.`);
          const resultPayload = {
            success: currentInitialStateForStream.success,
            message: currentInitialStateForStream.message || (currentInitialStateForStream.success ? 'Deployment completed successfully.' : (currentInitialStateForStream.error || 'Deployment failed.')),
            projectName: currentInitialStateForStream.projectName,
            deployedUrl: currentInitialStateForStream.deployedUrl,
            error: currentInitialStateForStream.error,
          };
          safeEnqueue('complete', resultPayload);
          cleanup();
          return; // Don't start poller if already done
      }

      pollerIntervalId = setInterval(() => {
        if (clientClosed) { // Double check, cleanup should stop interval but defense in depth
          console.log(`${sseLogPrefix} Poller: clientClosed is true, interval should have been cleared. Performing cleanup again.`);
          cleanup();
          return;
        }

        let currentState: DeploymentProgress | undefined;
        try {
          currentState = getDeploymentState(deploymentId);
        } catch (getStateError: any) {
          console.error(`${sseLogPrefix} CRITICAL ERROR in poller: Error calling getDeploymentState: ${getStateError.message}`, getStateError.stack);
          safeEnqueue('error', { message: "Internal server error retrieving deployment state. Stream terminated." });
          cleanup(); 
          return;
        }

        if (!currentState) {
          console.warn(`${sseLogPrefix} Poller: Deployment state for ${deploymentId} disappeared. Sending error and closing.`);
          safeEnqueue('error', { message: "Deployment state not found or removed. Stream terminated." });
          cleanup(); 
          return;
        }

        // Send new logs
        if (currentState.logs.length > lastLogIndex) {
          const newLogs = currentState.logs.slice(lastLogIndex);
          newLogs.forEach(log => safeEnqueue('log', log));
          lastLogIndex = currentState.logs.length;
        }

        // Send status update if changed
        if (currentState.status !== lastStatus) {
          safeEnqueue('status', currentState.status);
          lastStatus = currentState.status;
        }
        
        if (currentState.isDone) {
          console.log(`${sseLogPrefix} Poller: Deployment complete. Sending 'complete' event and closing stream.`);
          const resultPayload = {
            success: currentState.success,
            message: currentState.message || (currentState.success ? 'Deployment completed successfully.' : (currentState.error || 'Deployment failed.')),
            projectName: currentState.projectName,
            deployedUrl: currentState.deployedUrl,
            error: currentState.error,
          };
          safeEnqueue('complete', resultPayload);
          cleanup(); 
          // return; // Interval will be cleared by cleanup
        }
      }, POLLING_INTERVAL);

      // Handle client disconnect
      request.signal.addEventListener('abort', () => {
        console.log(`${sseLogPrefix} Client aborted connection (request.signal 'abort' event).`);
        cleanup();
      });
    },
    cancel(reason) {
      // This is called if the consumer (Next.js server) cancels the stream, not typically for client disconnects
      console.log(`${sseLogPrefix} Stream explicitly cancelled by consumer. Reason:`, reason);
      cleanup(); // Ensure resources are released
    }
  });

  return new Response(stream, {
    status: 200,
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      'Connection': 'keep-alive',
      'X-Accel-Buffering': 'no', // For Nginx if used as a reverse proxy
    },
  });
}

    