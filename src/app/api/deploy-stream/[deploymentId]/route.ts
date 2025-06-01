
// src/app/api/deploy-stream/[deploymentId]/route.ts
import { type NextRequest, NextResponse } from 'next/server';
import { getDeploymentState, type DeploymentProgress } from '@/lib/deploymentStore';

export const dynamic = 'force-dynamic'; // Ensures this route is not cached

export async function GET(
  request: NextRequest,
  { params }: { params: { deploymentId: string } }
) {
  try { // Top-level try-catch for the entire route handler
    const { deploymentId } = params;

    if (!deploymentId) {
      console.error("[SSE] Missing deploymentId in request params");
      return new Response('Missing deploymentId', { status: 400 });
    }
    console.log(`[SSE:${deploymentId}] Connection initiated. Validating deployment ID.`);

    const initialDeploymentState = getDeploymentState(deploymentId);
    if (!initialDeploymentState) {
      console.warn(`[SSE:${deploymentId}] Initial check: Deployment state not found for ID. Aborting stream setup.`);
      return new Response(JSON.stringify({ error: `Deployment ID '${deploymentId}' not found or has expired.` }), { 
        status: 404, 
        headers: { 'Content-Type': 'application/json' } 
      });
    }
    console.log(`[SSE:${deploymentId}] Deployment ID validated. Preparing stream.`);


    const stream = new ReadableStream({
      async start(controller) {
        console.log(`[SSE:${deploymentId}] Stream controller started.`);
        let lastLogIndex = 0;
        let lastStatus = '';
        let clientClosed = false; 

        const sendEvent = (event: string, data: any) => {
          if (clientClosed || controller.desiredSize === null) {
            return;
          }
          try {
            controller.enqueue(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
          } catch (e: any) {
            console.warn(`[SSE:${deploymentId}] Error enqueuing data for event '${event}': ${e.message}. Marking client as closed.`);
            clientClosed = true;
          }
        };

        const poller = setInterval(() => {
          try { // Wrap poller logic in try-catch
            if (clientClosed) { 
              clearInterval(poller);
              if (controller.desiredSize !== null) {
                try { controller.close(); } catch (e) { console.warn(`[SSE:${deploymentId}] Error closing controller during poller cleanup: ${e instanceof Error ? e.message : String(e)}`);}
              }
              return;
            }

            const currentState = getDeploymentState(deploymentId);

            if (currentState) {
              if (currentState.logs.length > lastLogIndex) {
                const newLogs = currentState.logs.slice(lastLogIndex);
                newLogs.forEach(log => sendEvent('log', log));
                lastLogIndex = currentState.logs.length;
              }

              if (currentState.status !== lastStatus) {
                sendEvent('status', currentState.status);
                lastStatus = currentState.status;
              }
              
              if (currentState.isDone) {
                console.log(`[SSE:${deploymentId}] Poller: Deployment complete. Sending 'complete' event.`);
                const resultPayload = {
                  success: currentState.success,
                  message: currentState.success ? 'Deployment completed successfully.' : (currentState.error || 'Deployment failed.'),
                  projectName: currentState.projectName,
                  deployedUrl: currentState.deployedUrl,
                  error: currentState.error,
                  logs: currentState.logs 
                };
                sendEvent('complete', resultPayload);
                clientClosed = true;
              }
            } else { 
              console.warn(`[SSE:${deploymentId}] Poller: Deployment state disappeared. Sending 'error' event and closing.`);
              sendEvent('error', { message: "Deployment state not found or removed unexpectedly." });
              clientClosed = true; 
            }
          } catch (pollerError: any) {
            console.error(`[SSE:${deploymentId}] Error in poller interval: ${pollerError.message}`, pollerError);
            try {
              if (!clientClosed && controller.desiredSize !== null) {
                controller.enqueue(`event: error\ndata: ${JSON.stringify({ message: "Internal stream error during polling." })}\n\n`);
              }
            } catch (enqueueError: any) {
              console.error(`[SSE:${deploymentId}] Failed to enqueue final error event after poller error: ${enqueueError.message}`);
            }
            clientClosed = true; 
            clearInterval(poller);
            if (controller.desiredSize !== null) {
              try { controller.close(); } catch (e) { console.warn(`[SSE:${deploymentId}] Error closing controller after poller error: ${e instanceof Error ? e.message : String(e)}`); }
            }
          }
        }, 750); 

        request.signal.addEventListener('abort', () => {
          console.log(`[SSE:${deploymentId}] Client aborted connection (request.signal detected).`);
          clientClosed = true; 
          // Poller will handle clearInterval and controller.close() in its next iteration
        });

      },
      cancel(reason) {
        const deploymentId = params?.deploymentId || "unknown_deployment_on_cancel";
        console.log(`[SSE:${deploymentId}] Stream explicitly cancelled by consumer. Reason:`, reason);
        // The `clientClosed` flag and poller clearInterval should handle cleanup.
      }
    });

    return new Response(stream, {
      headers: {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache, no-transform',
        'Connection': 'keep-alive',
        'X-Accel-Buffering': 'no', 
      },
    });

  } catch (error: any) { 
    const deploymentId = params?.deploymentId || "unknown_deployment";
    console.error(`[SSE:${deploymentId}] CRITICAL ERROR in GET handler during stream setup: ${error.message}`, error.stack);
    return new Response(JSON.stringify({ error: `Server error establishing stream: ${error.message}` }), { 
      status: 500,
      headers: { 'Content-Type': 'application/json' } 
    });
  }
}

