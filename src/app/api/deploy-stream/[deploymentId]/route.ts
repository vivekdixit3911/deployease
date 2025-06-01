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
    console.log(`[SSE:${deploymentId}] Connection initiated.`);

    const stream = new ReadableStream({
      async start(controller) {
        console.log(`[SSE:${deploymentId}] Stream started.`);
        let lastLogIndex = 0;
        let lastStatus = '';
        let clientClosed = false;

        const sendData = (event: string, data: any) => {
          if (clientClosed || controller.desiredSize === null) return; // Don't send if client gone or controller closed
          try {
            controller.enqueue(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
          } catch (e) {
            console.warn(`[SSE:${deploymentId}] Error enqueuing data:`, e instanceof Error ? e.message : String(e));
            // Controller might be closed by client abort or server-side completion
          }
        };

        const intervalId = setInterval(() => {
          if (clientClosed || controller.desiredSize === null) {
            clearInterval(intervalId);
            return;
          }

          const currentState = getDeploymentState(deploymentId);

          if (currentState) {
            // Send new logs
            if (currentState.logs.length > lastLogIndex) {
              for (let i = lastLogIndex; i < currentState.logs.length; i++) {
                sendData('log', currentState.logs[i]);
              }
              lastLogIndex = currentState.logs.length;
            }

            // Send status update if changed
            if (currentState.status !== lastStatus) {
              sendData('status', currentState.status);
              lastStatus = currentState.status;
            }
            
            if (currentState.isDone) {
              console.log(`[SSE:${deploymentId}] Deployment complete. Sending 'complete' event.`);
              const resultPayload = {
                success: currentState.success,
                message: currentState.success ? 'Deployment completed successfully.' : (currentState.error || 'Deployment failed.'),
                projectName: currentState.projectName,
                deployedUrl: currentState.deployedUrl,
                error: currentState.error,
                logs: currentState.logs // Send all logs at the end for completeness
              };
              sendData('complete', resultPayload);
              clearInterval(intervalId);
              if (!clientClosed && controller.desiredSize !== null) {
                try { controller.close(); } catch (e) { /* ignore */ }
              }
            }
          } else {
            console.warn(`[SSE:${deploymentId}] Deployment state not found. Sending error event.`);
            sendData('error', { message: "Deployment state not found or removed. The deployment might have expired or failed to initialize." });
            clearInterval(intervalId);
            if (!clientClosed && controller.desiredSize !== null) {
                try { controller.close(); } catch (e) { /* ignore */ }
            }
          }
        }, 750);

        request.signal.addEventListener('abort', () => {
          console.log(`[SSE:${deploymentId}] Client aborted connection.`);
          clientClosed = true;
          clearInterval(intervalId);
          if (controller.desiredSize !== null) { // Check if controller is still open
              try {
                  controller.close();
                  console.log(`[SSE:${deploymentId}] Controller closed due to client abort.`);
              } catch (e) {
                  // console.warn(`[SSE:${deploymentId}] Error closing controller on abort:`, e instanceof Error ? e.message : String(e));
              }
          }
        });
      },
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
    console.error(`[SSE:${deploymentId}] CRITICAL ERROR in GET handler:`, error.message, error.stack);
    return new Response('Internal Server Error establishing stream', { status: 500 });
  }
}
