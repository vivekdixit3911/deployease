
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
    return new Response(JSON.stringify({ error: 'Missing deploymentId in request parameters.' }), { 
        status: 400, 
        headers: { 'Content-Type': 'application/json', 'Connection': 'close' } 
    });
  }
  console.log(`[SSE Stream:${deploymentId}] Connection attempt received.`);

  const initialDeploymentState = getDeploymentState(deploymentId);
  if (!initialDeploymentState) {
    console.warn(`[SSE Stream:${deploymentId}] Invalid or expired deployment ID. Deployment state not found.`);
    return new Response(JSON.stringify({ error: `Deployment ID '${deploymentId}' not found or has expired.` }), { 
      status: 404, 
      headers: { 'Content-Type': 'application/json', 'Connection': 'close' } 
    });
  }
  console.log(`[SSE Stream:${deploymentId}] Deployment ID validated. Project: ${initialDeploymentState.projectName || 'N/A'}. Preparing stream.`);

  const stream = new ReadableStream({
    async start(controller) {
      console.log(`[SSE Stream:${deploymentId}] Stream controller 'start' method invoked.`);
      let lastLogIndex = 0;
      let lastStatus = ''; // Will be set on first poll
      let clientClosed = false;
      let pollerIntervalId: NodeJS.Timeout | null = null;

      const safeEnqueue = (event: string, data: any): boolean => {
        if (clientClosed || controller.desiredSize === null || controller.desiredSize <= 0) {
          // console.log(`[SSE Stream:${deploymentId}] safeEnqueue: Client closed or controller not ready/full. Skipping event '${event}'.`);
          if (controller.desiredSize === null || controller.desiredSize <=0) {
            // If controller is not ready (e.g. desiredSize is null or 0), we might be in a bad state
            // or client has closed abruptly. Mark clientClosed to stop further attempts.
            // clientClosed = true; // Consider this if issues persist
          }
          return false;
        }
        try {
          controller.enqueue(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
          // console.log(`[SSE Stream:${deploymentId}] Enqueued event: ${event}`);
          return true;
        } catch (e: any) {
          console.error(`[SSE Stream:${deploymentId}] safeEnqueue: Error enqueuing data for event '${event}': ${e.message}. Marking client as closed.`);
          clientClosed = true; // Stop further attempts on this stream
          // Cleanup will happen on next poller check or if abort is called
          return false;
        }
      };

      const cleanup = () => {
        if (clientClosed) return; // Already cleaning up or cleaned up
        clientClosed = true; // Mark as closing/closed to prevent race conditions

        console.log(`[SSE Stream:${deploymentId}] Cleanup invoked.`);
        if (pollerIntervalId) {
          clearInterval(pollerIntervalId);
          pollerIntervalId = null;
          console.log(`[SSE Stream:${deploymentId}] Poller interval cleared.`);
        }
        if (controller.desiredSize !== null) { 
          try {
            controller.close();
            console.log(`[SSE Stream:${deploymentId}] Stream controller closed.`);
          } catch (e:any) {
            // This can happen if controller is already closing or in a bad state.
            console.warn(`[SSE Stream:${deploymentId}] Error closing controller during cleanup: ${e.message}`);
          }
        }
      };
      
      // Send initial state immediately
      const currentInitialState = getDeploymentState(deploymentId);
      if (currentInitialState) {
        safeEnqueue('status', currentInitialState.status);
        lastStatus = currentInitialState.status;
        currentInitialState.logs.forEach(log => safeEnqueue('log', log));
        lastLogIndex = currentInitialState.logs.length;
      } else {
        // This should not happen if initial check passed, but as a safeguard
        safeEnqueue('error', { message: "Initial deployment state disappeared unexpectedly. Stream closing." });
        cleanup();
        return;
      }

      pollerIntervalId = setInterval(() => {
        if (clientClosed) {
          // console.log(`[SSE Stream:${deploymentId}] Poller: Client marked as closed. Performing cleanup if not already done.`);
          // If clientClosed is true, cleanup should have been called or is in progress.
          // If poller is still running, ensure cleanup.
          if (pollerIntervalId) cleanup();
          return;
        }

        try {
          const currentState = getDeploymentState(deploymentId);

          if (!currentState) {
            console.warn(`[SSE Stream:${deploymentId}] Poller: Deployment state disappeared. Sending error and closing.`);
            safeEnqueue('error', { message: "Deployment state not found or removed. Stream terminated." });
            cleanup(); // Perform full cleanup
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
              // logs: currentState.logs // Optionally send all logs on completion, can be large
            };
            safeEnqueue('complete', resultPayload);
            cleanup(); // Perform full cleanup
            return;
          }
        } catch (pollerError: any) {
          console.error(`[SSE Stream:${deploymentId}] CRITICAL ERROR in poller interval: ${pollerError.message}`, pollerError.stack);
          // Attempt to inform client before closing
          safeEnqueue('error', { message: "Internal server error during stream polling. Check server logs." });
          cleanup(); // Perform full cleanup
        }
      }, POLLING_INTERVAL);

      request.signal.addEventListener('abort', () => {
        console.log(`[SSE Stream:${deploymentId}] Client aborted connection (request.signal 'abort' event).`);
        cleanup();
      });
    },
    cancel(reason) {
      console.log(`[SSE Stream:${deploymentId}] Stream explicitly cancelled by consumer. Reason:`, reason);
      // This is an internal ReadableStream cancellation, usually implies the 'start' method's cleanup
      // should handle resource release. The 'abort' listener is more direct for client-initiated closures.
      // We call cleanup here as well to be safe, though it might be redundant if 'abort' also fires.
      // Check clientClosed to avoid double cleanup.
      // No access to pollerIntervalId or controller directly from here in this scope.
      // Relies on the fact that if cancel() is called, clientClosed should eventually be true.
      // The cleanup logic in `start` (via abort or poller loop) should handle it.
      // For good measure, ensure that the `start` method's cleanup logic is robust.
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
