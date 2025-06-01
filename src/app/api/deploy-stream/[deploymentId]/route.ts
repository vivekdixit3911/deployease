// src/app/api/deploy-stream/[deploymentId]/route.ts
import { type NextRequest } from 'next/server';
import { getDeploymentState, type DeploymentProgress } from '@/lib/deploymentStore';

export const dynamic = 'force-dynamic'; // Ensures this route is not cached

export async function GET(
  request: NextRequest,
  { params }: { params: { deploymentId: string } }
) {
  const { deploymentId } = params;

  if (!deploymentId) {
    return new Response('Missing deploymentId', { status: 400 });
  }

  const stream = new ReadableStream({
    async start(controller) {
      let lastLogIndex = 0;
      let lastStatus = '';
      let clientClosed = false;

      const sendData = (event: string, data: any) => {
        if (clientClosed) return;
        try {
          controller.enqueue(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
        } catch (e) {
          console.error(`Error enqueuing data for ${deploymentId}:`, e);
          // Controller might be closed
        }
      };

      const intervalId = setInterval(() => {
        if (clientClosed) {
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
            if (!clientClosed) controller.close();
            // Optional: Aggressively clean up state if desired, but be careful if multiple clients could attach
            // deploymentStates.delete(deploymentId); 
          }
        } else {
          // If state disappears or was never there
          sendData('error', { message: "Deployment state not found or removed. The deployment might have expired or failed to initialize." });
          clearInterval(intervalId);
          if (!clientClosed) controller.close();
        }
      }, 750); // Poll for updates slightly more frequently

      // Clean up when the client closes the connection
      request.signal.addEventListener('abort', () => {
        clientClosed = true;
        clearInterval(intervalId);
        if (controller.desiredSize !== null) { // Check if controller is still open
            try {
                controller.close();
            } catch (e) {
                // Ignore if already closed
            }
        }
        console.log(`Client aborted connection for deploymentId: ${deploymentId}`);
      });
    },
  });

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform', // no-transform is important for SSE
      'Connection': 'keep-alive',
      'X-Accel-Buffering': 'no', // For Nginx buffering issues
    },
  });
}
