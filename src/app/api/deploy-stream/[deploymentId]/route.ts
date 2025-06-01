
// src/app/api/deploy-stream/[deploymentId]/route.ts
import { type NextRequest, NextResponse } from 'next/server';
import { getDeploymentState, type DeploymentProgress } from '@/lib/deploymentStore';

export const dynamic = 'force-dynamic'; // Ensures this route is not cached

export async function GET(
  request: NextRequest,
  { params }: { params: { deploymentId: string } }
) {
  const { deploymentId } = params;

  if (!deploymentId) {
    console.error("[SSE] Critical: Missing deploymentId in request params.");
    return new Response(JSON.stringify({ error: 'Missing deploymentId in request parameters.' }), { 
        status: 400, 
        headers: { 'Content-Type': 'application/json' } 
    });
  }
  console.log(`[SSE:${deploymentId}] Connection attempt received.`);

  // Validate deploymentId and initial state existence *before* creating the stream
  const initialDeploymentState = getDeploymentState(deploymentId);
  if (!initialDeploymentState) {
    console.warn(`[SSE:${deploymentId}] Invalid or expired deployment ID. Deployment state not found.`);
    return new Response(JSON.stringify({ error: `Deployment ID '${deploymentId}' not found or has expired.` }), { 
      status: 404, 
      headers: { 'Content-Type': 'application/json' } 
    });
  }
  console.log(`[SSE:${deploymentId}] Deployment ID validated. Project: ${initialDeploymentState.projectName || 'N/A'}. Preparing stream.`);

  const stream = new ReadableStream({
    async start(controller) {
      console.log(`[SSE:${deploymentId}] Stream controller 'start' method invoked.`);
      let lastLogIndex = 0;
      let lastStatus = initialDeploymentState.status; // Initialize with current status
      let clientClosed = false;
      let pollerIntervalId: NodeJS.Timeout | null = null;

      const safeEnqueue = (event: string, data: any) => {
        if (clientClosed || controller.desiredSize === null) {
          // console.log(`[SSE:${deploymentId}] safeEnqueue: Client closed or controller not ready. Skipping event '${event}'.`);
          return false;
        }
        try {
          controller.enqueue(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
          return true;
        } catch (e: any) {
          console.warn(`[SSE:${deploymentId}] safeEnqueue: Error enqueuing data for event '${event}': ${e.message}. Marking client as closed.`);
          clientClosed = true; // Critical: stop further attempts
          return false;
        }
      };

      const cleanup = () => {
        if (pollerIntervalId) {
          clearInterval(pollerIntervalId);
          pollerIntervalId = null;
          console.log(`[SSE:${deploymentId}] Poller interval cleared.`);
        }
        if (controller.desiredSize !== null) { // Check if controller is still open
          try {
            controller.close();
            console.log(`[SSE:${deploymentId}] Stream controller closed.`);
          } catch (e) {
            console.warn(`[SSE:${deploymentId}] Error closing controller during cleanup: ${e instanceof Error ? e.message : String(e)}`);
          }
        }
      };

      // Initial status send
      safeEnqueue('status', initialDeploymentState.status);
      initialDeploymentState.logs.forEach(log => safeEnqueue('log', log));
      lastLogIndex = initialDeploymentState.logs.length;


      pollerIntervalId = setInterval(() => {
        if (clientClosed) {
          // console.log(`[SSE:${deploymentId}] Poller: Client marked as closed. Performing cleanup.`);
          cleanup();
          return;
        }

        try {
          const currentState = getDeploymentState(deploymentId);

          if (!currentState) {
            console.warn(`[SSE:${deploymentId}] Poller: Deployment state disappeared for ID. Sending error and closing.`);
            safeEnqueue('error', { message: "Deployment state not found or removed unexpectedly. Stream terminated." });
            clientClosed = true; // Signal to cleanup in the next check or if error during enqueue
            cleanup(); // Immediate cleanup
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
          
          // Check for completion
          if (currentState.isDone) {
            console.log(`[SSE:${deploymentId}] Poller: Deployment complete. Sending 'complete' event.`);
            const resultPayload = {
              success: currentState.success,
              message: currentState.success ? 'Deployment completed successfully.' : (currentState.error || 'Deployment failed.'),
              projectName: currentState.projectName,
              deployedUrl: currentState.deployedUrl,
              error: currentState.error,
              logs: currentState.logs // Send all logs on completion
            };
            safeEnqueue('complete', resultPayload);
            clientClosed = true; // Signal to cleanup
            cleanup(); // Immediate cleanup
            return;
          }
        } catch (pollerError: any) {
          console.error(`[SSE:${deploymentId}] CRITICAL ERROR in poller interval: ${pollerError.message}`, pollerError.stack);
          try {
            if (!clientClosed) { // Avoid sending error if already trying to close due to enqueue failure
                safeEnqueue('error', { message: "Internal server error during stream polling. Check server logs." });
            }
          } catch (finalEnqueueError: any) {
            console.error(`[SSE:${deploymentId}] Failed to enqueue final error event after poller error: ${finalEnqueueError.message}`);
          }
          clientClosed = true; // Signal to cleanup
          cleanup(); // Immediate cleanup
        }
      }, 750); // Polling interval

      request.signal.addEventListener('abort', () => {
        console.log(`[SSE:${deploymentId}] Client aborted connection (request.signal 'abort' event).`);
        clientClosed = true;
        // The poller will see clientClosed=true and clean up on its next tick.
        // Or, if the poller isn't running or to be more immediate:
        cleanup();
      });

    },
    cancel(reason) {
      // This 'cancel' is called if the consumer of the ReadableStream calls .cancel() on it.
      // For EventSource, this usually happens if the client closes the connection,
      // which should also trigger the 'abort' event on request.signal.
      console.log(`[SSE:${deploymentId}] Stream explicitly cancelled by consumer. Reason:`, reason);
      // Ensure cleanup, though 'abort' listener should also handle this.
      // No direct access to 'clientClosed' or 'pollerIntervalId' here, rely on abort or other mechanisms.
      // The ReadableStream spec implies the interval should be stopped by the start() method's cleanup logic
      // when the stream is cancelled. The 'abort' listener is more direct for client-initiated closures.
    }
  });

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform', // Important: no-transform to prevent intermediate buffering
      'Connection': 'keep-alive',
      'X-Accel-Buffering': 'no', // For Nginx: disable response buffering
      // Consider 'Content-Encoding': 'identity' if issues with compression proxies
    },
  });
}
