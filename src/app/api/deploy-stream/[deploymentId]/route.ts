
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

  if (!deploymentId) {
    console.error("[SSE Stream] Critical: Missing deploymentId in request params.");
    return NextResponse.json({ error: 'Missing deploymentId in request parameters.' }, { 
        status: 400, 
        headers: { 'Content-Type': 'application/json', 'Connection': 'close' } 
    });
  }
  console.log(`[SSE Stream:${deploymentId}] Connection attempt received.`);

  const initialDeploymentState = getDeploymentState(deploymentId);
  if (!initialDeploymentState) {
    console.warn(`[SSE Stream:${deploymentId}] Invalid or expired deployment ID. Deployment state not found.`);
    return NextResponse.json({ error: `Deployment ID '${deploymentId}' not found or has expired.` }, { 
      status: 404, 
      headers: { 'Content-Type': 'application/json', 'Connection': 'close' } 
    });
  }
  console.log(`[SSE Stream:${deploymentId}] Deployment ID validated. Project: ${initialDeploymentState.projectName || 'N/A'}. Preparing stream.`);

  const stream = new ReadableStream({
    async start(controller) {
      console.log(`[SSE Stream:${deploymentId}] Stream controller 'start' method invoked.`);
      let lastLogIndex = 0;
      let lastStatus = initialDeploymentState.status; // Initialize with current status
      let clientClosed = false;
      let pollerIntervalId: NodeJS.Timeout | null = null;

      const safeEnqueue = (event: string, data: any): boolean => {
        if (clientClosed) {
          // console.log(`[SSE Stream:${deploymentId}] safeEnqueue: Client closed or controller full. Skipping event '${event}'.`);
          return false;
        }
        // Check if controller is still usable. DesiredSize can be null if the stream was closed abruptly.
        if (controller.desiredSize === null || controller.desiredSize <= 0) {
            console.warn(`[SSE Stream:${deploymentId}] safeEnqueue: Controller desiredSize is ${controller.desiredSize}. Assuming client closed or stream broke. Skipping event '${event}'.`);
            // It's safer to assume client is closed if desiredSize is 0 or null
            // clientClosed = true; // This might be too aggressive, rely on cleanup
            return false;
        }
        try {
          controller.enqueue(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
          // console.log(`[SSE Stream:${deploymentId}] Enqueued event: ${event}`);
          return true;
        } catch (e: any) {
          console.error(`[SSE Stream:${deploymentId}] safeEnqueue: Error enqueuing data for event '${event}': ${e.message}. Marking client as closed.`);
          clientClosed = true; 
          // No direct access to cleanup from here, but clientClosed flag will stop poller
          return false;
        }
      };

      const cleanup = () => {
        if (clientClosed) return; 
        clientClosed = true; 

        console.log(`[SSE Stream:${deploymentId}] Cleanup invoked.`);
        if (pollerIntervalId) {
          clearInterval(pollerIntervalId);
          pollerIntervalId = null;
          console.log(`[SSE Stream:${deploymentId}] Poller interval cleared.`);
        }
        // Only try to close if controller seems active
        if (controller.desiredSize !== null) { 
          try {
            controller.close();
            console.log(`[SSE Stream:${deploymentId}] Stream controller closed.`);
          } catch (e:any) {
            console.warn(`[SSE Stream:${deploymentId}] Error closing controller during cleanup: ${e.message}`);
          }
        }
      };
      
      // Send initial state immediately
      // Re-fetch state in case it changed between the initial check and stream start
      const currentInitialStateForStream = getDeploymentState(deploymentId);
      if (currentInitialStateForStream) {
        safeEnqueue('status', currentInitialStateForStream.status);
        lastStatus = currentInitialStateForStream.status;
        currentInitialStateForStream.logs.forEach(log => safeEnqueue('log', log));
        lastLogIndex = currentInitialStateForStream.logs.length;
        
        if (currentInitialStateForStream.isDone) {
            console.log(`[SSE Stream:${deploymentId}] Deployment was already complete at stream start. Sending 'complete' event and closing.`);
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

      } else {
        // State disappeared between initial check and stream start
        console.warn(`[SSE Stream:${deploymentId}] Initial deployment state disappeared before stream could fully start. Sending error.`);
        safeEnqueue('error', { message: "Deployment state disappeared unexpectedly. Stream closing." });
        cleanup();
        return; // Don't start poller
      }

      pollerIntervalId = setInterval(() => {
        if (clientClosed) {
          // console.log(`[SSE Stream:${deploymentId}] Poller: Client marked as closed. Performing cleanup if not already done.`);
          if (pollerIntervalId) cleanup(); // Ensure cleanup if poller is somehow still running
          return;
        }

        try {
          const currentState = getDeploymentState(deploymentId);

          if (!currentState) {
            console.warn(`[SSE Stream:${deploymentId}] Poller: Deployment state disappeared. Sending error and closing.`);
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
            console.log(`[SSE Stream:${deploymentId}] Poller: Deployment complete. Sending 'complete' event and closing stream.`);
            const resultPayload = {
              success: currentState.success,
              message: currentState.message || (currentState.success ? 'Deployment completed successfully.' : (currentState.error || 'Deployment failed.')),
              projectName: currentState.projectName,
              deployedUrl: currentState.deployedUrl,
              error: currentState.error,
            };
            safeEnqueue('complete', resultPayload);
            cleanup(); 
            return;
          }
        } catch (pollerError: any) {
          console.error(`[SSE Stream:${deploymentId}] CRITICAL ERROR in poller interval: ${pollerError.message}`, pollerError.stack);
          safeEnqueue('error', { message: "Internal server error during stream polling. Check server logs." });
          cleanup(); 
        }
      }, POLLING_INTERVAL);

      request.signal.addEventListener('abort', () => {
        console.log(`[SSE Stream:${deploymentId}] Client aborted connection (request.signal 'abort' event).`);
        cleanup();
      });
    },
    cancel(reason) {
      // This is called if the consumer (Next.js server) cancels the stream, not typically for client disconnects
      console.log(`[SSE Stream:${deploymentId}] Stream explicitly cancelled by consumer. Reason:`, reason);
      // The `start` method's cleanup (via abort or poller loop) should handle resource release.
      // No direct access to pollerIntervalId or controller directly from here.
      // We ensure `clientClosed` is set, which the poller loop and `start` method's logic respects.
      // If this `cancel` is called, we can assume the stream is no longer viable.
      // The cleanup in `start` will be triggered by `clientClosed` being true or via `abort`.
    }
  });

  return new Response(stream, {
    status: 200,
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      'Connection': 'keep-alive',
      'X-Accel-Buffering': 'no', // For Nginx
    },
  });
}

