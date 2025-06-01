
// src/lib/deploymentStore.ts
export interface DeploymentProgress {
  id: string;
  logs: string[];
  status: string; 
  message?: string; // Message associated with completion or final status
  error?: string;
  success?: boolean; // Undefined until completion
  projectName?: string;
  deployedUrl?: string;
  isDone: boolean;
  createdAt: number; // For cleanup purposes
}

export const deploymentStates = new Map<string, DeploymentProgress>();

export function initializeDeployment(deploymentId: string): void {
  if (deploymentStates.has(deploymentId)) {
    console.warn(`[DeploymentStore] Deployment ID ${deploymentId} already exists. Re-initializing.`);
  }
  const initialState: DeploymentProgress = {
    id: deploymentId,
    logs: ['Deployment initialized...'],
    status: 'Initialized',
    isDone: false,
    createdAt: Date.now(),
  };
  deploymentStates.set(deploymentId, initialState);
  console.log(`[DeploymentStore] Initialized deployment: ${deploymentId}`);
}

export function addLog(deploymentId: string, log: string): void {
  const state = deploymentStates.get(deploymentId);
  if (state && !state.isDone) { // Only add logs if not done to prevent modification after completion
    state.logs.push(log);
  } else if (!state) {
    console.warn(`[DeploymentStore:addLog] Deployment state not found for ID: ${deploymentId}`);
  }
}

export function updateStatus(deploymentId: string, status: string): void {
  const state = deploymentStates.get(deploymentId);
  if (state && !state.isDone) {
    state.status = status;
    // Optionally add status change to logs automatically
    // state.logs.push(`Status: ${status}`); 
    console.log(`[DeploymentStore:updateStatus] ${deploymentId} status updated: ${status}`);
  } else if (!state) {
    console.warn(`[DeploymentStore:updateStatus] Deployment state not found for ID: ${deploymentId}`);
  }
}

export function setDeploymentComplete(
  deploymentId: string,
  result: {
    success: boolean;
    message: string;
    projectName?: string;
    deployedUrl?: string;
    error?: string;
  }
): void {
  const state = deploymentStates.get(deploymentId);
  if (state) {
    if (state.isDone) {
      console.warn(`[DeploymentStore:setDeploymentComplete] ${deploymentId} is already marked as done. Ignoring update.`);
      return;
    }
    state.isDone = true;
    state.success = result.success;
    state.message = result.message; // Overall message for the deployment result
    state.status = result.success ? 'Completed Successfully' : 'Failed';
    state.projectName = result.projectName || state.projectName; // Preserve if already set
    state.deployedUrl = result.deployedUrl;
    state.error = result.error || (result.success ? undefined : result.message);
    
    // Add final log message
    // state.logs.push(`--- Deployment ${result.success ? 'Succeeded' : 'Failed'} ---`);
    // state.logs.push(result.message);
    // if (result.error && !result.success) state.logs.push(`Error details: ${result.error}`);

    console.log(`[DeploymentStore:setDeploymentComplete] ${deploymentId} marked as complete. Success: ${result.success}`);
  } else {
    console.warn(`[DeploymentStore:setDeploymentComplete] Deployment state not found for ID: ${deploymentId}. Cannot mark as complete.`);
  }
}

export function getDeploymentState(deploymentId: string): DeploymentProgress | undefined {
  return deploymentStates.get(deploymentId);
}

// Basic cleanup for old, completed deployments
const CLEANUP_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes
const MAX_DEPLOYMENT_STATE_AGE_MS = 60 * 60 * 1000; // 1 hour

function cleanupOldDeployments() {
  const now = Date.now();
  let cleanedCount = 0;
  // console.log('[DeploymentStoreCleanup] Running cleanup task...');
  for (const [id, state] of deploymentStates.entries()) {
    if (state.isDone && (now - state.createdAt > MAX_DEPLOYMENT_STATE_AGE_MS)) {
      deploymentStates.delete(id);
      cleanedCount++;
    }
  }
  if (cleanedCount > 0) {
    console.log(`[DeploymentStoreCleanup] Cleaned up ${cleanedCount} old deployment states.`);
  }
}

setInterval(cleanupOldDeployments, CLEANUP_INTERVAL_MS);
console.log('[DeploymentStore] Initialized with cleanup interval.');
