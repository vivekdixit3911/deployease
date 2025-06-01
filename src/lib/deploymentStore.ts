// src/lib/deploymentStore.ts
export interface DeploymentProgress {
  id: string;
  logs: string[];
  status: string; // e.g., "Starting", "Cloning", "Building", "Uploading", "Success", "Failed"
  error?: string;
  success?: boolean;
  projectName?: string;
  deployedUrl?: string;
  isDone: boolean;
  // Consider adding a timestamp for cleanup purposes in a real app
  // timestamp: number; 
}

// This is an in-memory store. In a real-world scenario with multiple server instances,
// you'd use a distributed store like Redis or a database + pub/sub.
export const deploymentStates = new Map<string, DeploymentProgress>();

export function initializeDeployment(deploymentId: string): void {
  if (deploymentStates.has(deploymentId)) {
    console.warn(`Deployment ID ${deploymentId} already exists. Re-initializing.`);
  }
  deploymentStates.set(deploymentId, {
    id: deploymentId,
    logs: ['Deployment initialized...'],
    status: 'Initialized',
    isDone: false,
    // timestamp: Date.now(),
  });
  // console.log(`Initialized deployment: ${deploymentId}`, deploymentStates.get(deploymentId));
}

export function addLog(deploymentId: string, log: string): void {
  const state = deploymentStates.get(deploymentId);
  if (state) {
    state.logs.push(log);
    // console.log(`[${deploymentId}] Log added: ${log}`);
  } else {
    console.warn(`[addLog] Deployment state not found for ID: ${deploymentId}`);
  }
}

export function updateStatus(deploymentId: string, status: string): void {
  const state = deploymentStates.get(deploymentId);
  if (state) {
    state.status = status;
    addLog(deploymentId, `Status: ${status}`); // Also log status changes
    // console.log(`[${deploymentId}] Status updated: ${status}`);
  } else {
    console.warn(`[updateStatus] Deployment state not found for ID: ${deploymentId}`);
  }
}

export function setDeploymentComplete(
  deploymentId: string,
  result: {
    success: boolean;
    message: string;
    projectName?: string;
    deployedUrl?: string;
    error?: string; // This should be the primary error message if !success
  }
): void {
  const state = deploymentStates.get(deploymentId);
  if (state) {
    state.isDone = true;
    state.success = result.success;
    state.status = result.success ? 'Completed Successfully' : 'Failed';
    state.projectName = result.projectName;
    state.deployedUrl = result.deployedUrl;
    // If an error field is explicitly provided, use it. Otherwise, use message for failure.
    state.error = result.error || (result.success ? undefined : result.message);
    addLog(deploymentId, `Deployment ${result.success ? 'succeeded' : 'failed'}: ${result.message}`);
    // console.log(`[${deploymentId}] Deployment complete. Success: ${result.success}`);
  } else {
    console.warn(`[setDeploymentComplete] Deployment state not found for ID: ${deploymentId}`);
  }
}

export function getDeploymentState(deploymentId: string): DeploymentProgress | undefined {
  return deploymentStates.get(deploymentId);
}

// Basic cleanup for old, completed deployments to prevent unbounded memory growth.
// In a production app, this needs to be more robust and consider server restarts.
const CLEANUP_INTERVAL = 5 * 60 * 1000; // 5 minutes
const MAX_DEPLOYMENT_AGE = 60 * 60 * 1000; // 1 hour

setInterval(() => {
  const now = Date.now();
  let cleanedCount = 0;
  deploymentStates.forEach((state, id) => {
    // Check if state has a timestamp, if not, we can't effectively clean it by age.
    // For simplicity, we'll assume we add a timestamp when initializing if using this.
    // Currently, no timestamp is added, so this cleanup is illustrative.
    // A more robust way would be to track creation time.
    // For now, just delete if it's done. A real app needs better criteria.
    if (state.isDone) { // Simple: just remove if done (not ideal as client might still be looking)
        // A better approach is to remove if done AND old.
        // For now, this is a placeholder for a real cleanup strategy.
        // To avoid issues with very short-lived states, we might not delete immediately here
        // or only delete very old "done" states.
    }
  });
  // if (cleanedCount > 0) {
  //   console.log(`[DeploymentStoreCleanup] Cleaned up ${cleanedCount} old deployment states.`);
  // }
}, CLEANUP_INTERVAL);
