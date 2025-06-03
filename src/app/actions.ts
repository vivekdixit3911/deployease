
// src/app/actions.ts
'use server';

import fs from 'fs/promises';
import path from 'path';
import { exec } from 'child_process';
import { promisify } from 'util';
import JSZip from 'jszip';
import mime from 'mime-types';
import { PutObjectCommand } from '@aws-sdk/client-s3';
import { s3Client, OLA_S3_BUCKET_NAME, MissingS3ConfigError } from '@/lib/s3Client';
import { TEMP_UPLOAD_DIR } from '@/config/constants';
// AI Fix flow is present but not used in this simplified version
// import { fixCodeInFile, type FixCodeInput, type FixCodeOutput } from '@/ai/flows/fix-code-flow';

const execAsync = promisify(exec);
const MAX_LOG_LINES_TO_CLIENT = 50;

export interface DeploymentResult {
  success: boolean;
  message: string;
  projectName?: string;
  deployedUrl?: string;
  error?: string;
  logs: string[];
}

function extractErrorMessage(error: any): string {
  const defaultMessage = 'An unknown error occurred.';
  const maxLength = 250;

  if (!error) return defaultMessage;

  let extractedMessage: string;

  if (error instanceof Error) {
    extractedMessage = error.message || defaultMessage;
  } else if (typeof error === 'string') {
    extractedMessage = error || defaultMessage;
  } else {
    extractedMessage = defaultMessage;
  }
  
  return extractedMessage.length > maxLength ? extractedMessage.substring(0, maxLength - 3) + '...' : extractedMessage;
}

async function ensureDirectoryExists(dirPath: string, logs: string[], step: string): Promise<void> {
  const logPrefix = `[ensureDirectoryExists:${step}]`;
  logs.push(`${logPrefix} Ensuring directory exists: ${dirPath}`);
  try {
    await fs.mkdir(dirPath, { recursive: true });
    logs.push(`${logPrefix} Successfully ensured directory exists: ${dirPath}`);
  } catch (error: any) {
    const errorMsg = `${logPrefix} Failed to create directory ${dirPath}: ${error.message || 'Unknown error creating directory'}`;
    logs.push(errorMsg);
    console.error(errorMsg, error);
    throw new Error(errorMsg);
  }
}

async function uploadDirectoryRecursiveS3(
  localDirPath: string,
  s3BaseKey: string,
  logs: string[]
): Promise<void> {
  const logPrefix = `[uploadDirectoryRecursiveS3]`;
  logs.push(`${logPrefix} Starting S3 upload from ${localDirPath} to s3://${OLA_S3_BUCKET_NAME}/${s3BaseKey}`);

  if (!OLA_S3_BUCKET_NAME) {
    const errorMsg = `${logPrefix} Critical Error: OLA_S3_BUCKET_NAME is not configured.`;
    logs.push(errorMsg);
    throw new MissingS3ConfigError(errorMsg);
  }
  const currentS3Client = s3Client();

  const entries = await fs.readdir(localDirPath, { withFileTypes: true });
  for (const entry of entries) {
    const localEntryPath = path.join(localDirPath, entry.name);
    const cleanEntryName = entry.name.replace(/^\/+|\/+$/g, '');
    const s3ObjectKey = `${s3BaseKey}/${cleanEntryName}`.replace(/^\/+|\/+$/g, '').replace(/\/\//g, '/');

    if (entry.isDirectory()) {
      logs.push(`${logPrefix} Recursively uploading directory contents of ${localEntryPath} under S3 key prefix ${s3ObjectKey}`);
      await uploadDirectoryRecursiveS3(localEntryPath, s3ObjectKey, logs);
    } else {
      logs.push(`${logPrefix} Uploading file ${localEntryPath} to S3: s3://${OLA_S3_BUCKET_NAME}/${s3ObjectKey}...`);
      const fileBuffer = await fs.readFile(localEntryPath);
      const contentType = mime.lookup(entry.name) || 'application/octet-stream';

      const command = new PutObjectCommand({
        Bucket: OLA_S3_BUCKET_NAME,
        Key: s3ObjectKey,
        Body: fileBuffer,
        ContentType: contentType,
      });
      await currentS3Client.send(command);
      logs.push(`${logPrefix} Uploaded ${localEntryPath} to s3://${OLA_S3_BUCKET_NAME}/${s3ObjectKey} successfully.`);
    }
  }
  logs.push(`${logPrefix} Finished S3 upload for directory ${localDirPath} to base key ${s3BaseKey}`);
}

const sanitizeName = (name: string | undefined | null): string => {
  if (!name) return 'untitled-project';
  return name
    .trim()
    .replace(/\.zip$/i, '') 
    .replace(/\.git$/i, '') 
    .replace(/\/$/, '') 
    .split('/') 
    .pop() || 'untitled-project' 
    .replace(/\s+/g, '-') 
    .replace(/[^a-zA-Z0-9-]/g, '') 
    .replace(/-+/g, '-') 
    .replace(/^-+|-+$/g, '') 
    .toLowerCase() || 'untitled-project'; 
};

interface FrameworkDetectionResult {
  framework: string; 
  build_command?: string;
  output_directory?: string;
  reasoning?: string;
  project_type_context?: string; 
}

// This function analyzes package.json or infers type for static sites.
function nonAIDetectFramework(packageJsonContent: string | null, fileNameAnalyzed: string, logs: string[]): FrameworkDetectionResult {
  const logPrefix = `[nonAIDetectFramework]`;
  logs.push(`${logPrefix} Input file for analysis: ${fileNameAnalyzed}.`);
  if (packageJsonContent && fileNameAnalyzed.includes('package.json')) {
    logs.push(`${logPrefix} Analyzing package.json...`);
    try {
      const pkg = JSON.parse(packageJsonContent);
      const dependencies = { ...pkg.dependencies, ...pkg.devDependencies };
      const scripts = pkg.scripts || {};
      const isTypeScript = !!(dependencies.typescript || pkg.types || pkg.typings); 

      if (dependencies.next) {
        logs.push(`${logPrefix} Detected Next.js.`);
        return { framework: 'nextjs', build_command: scripts.build || 'npm run build --if-present || next build', output_directory: '.next', reasoning: "Next.js dependency found.", project_type_context: `Next.js ${isTypeScript ? 'TypeScript' : 'JavaScript'} project` };
      }
      if (dependencies['@remix-run/dev'] || dependencies.remix) {
        logs.push(`${logPrefix} Detected Remix.`);
        return { framework: 'remix', build_command: scripts.build || 'npm run build --if-present || remix build', output_directory: 'public/build', reasoning: "Remix dependency found.", project_type_context: `Remix ${isTypeScript ? 'TypeScript' : 'JavaScript'} project` };
      }
      if (dependencies['react-scripts']) {
        logs.push(`${logPrefix} Detected Create React App.`);
        return { framework: 'cra', build_command: scripts.build || 'npm run build', output_directory: 'build', reasoning: "Create React App (react-scripts) dependency found.", project_type_context: `Create React App ${isTypeScript ? 'TypeScript' : 'JavaScript'} project` };
      }
      if (dependencies.vite && (dependencies['@vitejs/plugin-react'] || dependencies['@vitejs/plugin-react-swc'])) {
        logs.push(`${logPrefix} Detected Vite with React.`);
        return { framework: 'vite-react', build_command: scripts.build || 'npm run build --if-present || vite build', output_directory: 'dist', reasoning: "Vite with React plugin detected.", project_type_context: `Vite React ${isTypeScript ? 'TypeScript' : 'JavaScript'} project` };
      }
      if (dependencies.react && dependencies['react-dom']) {
        logs.push(`${logPrefix} Detected Generic React project.`);
        return { framework: 'generic-react', build_command: scripts.build || 'npm run build', output_directory: 'dist', reasoning: "Generic React (react and react-dom) dependencies found.", project_type_context: `Generic React ${isTypeScript ? 'TypeScript' : 'JavaScript'} project` };
      }

      logs.push(`${logPrefix} package.json found, but no clear common framework indicators. Assuming static or custom Node.js build.`);
      if (scripts.build) {
        logs.push(`${logPrefix} Found 'build' script: ${scripts.build}. Assuming custom build outputting to 'dist'.`);
        return { framework: 'custom-build', build_command: scripts.build, output_directory: 'dist', reasoning: "package.json with a build script, but unrecognized frontend framework. Assuming 'dist' output.", project_type_context: `Custom build project ${isTypeScript ? 'with TypeScript' : ''}`.trim() };
      }
      logs.push(`${logPrefix} No specific framework or standard build script found in package.json. Assuming static.`);
      return { framework: 'static', reasoning: "package.json present but no specific framework indicators or standard build script found.", project_type_context: 'Static project or Node.js backend' };

    } catch (e: any) {
      logs.push(`${logPrefix} Error parsing package.json: ${e.message || 'Unknown parsing error'}. Assuming static.`);
      return { framework: 'static', reasoning: `Failed to parse package.json: ${e.message || 'Unknown parsing error'}`, project_type_context: 'Static project (package.json parse error)' };
    }
  } else if (fileNameAnalyzed.includes('index.html')) {
    logs.push(`${logPrefix} No package.json prioritized. index.html found. Assuming static.`);
    return { framework: 'static', reasoning: "index.html found, no package.json prioritized.", project_type_context: 'Static HTML project' };
  }

  logs.push(`${logPrefix} No package.json or index.html found for analysis. Assuming static.`);
  return { framework: 'static', reasoning: "No definitive project files (package.json, index.html) found for analysis.", project_type_context: 'Static project (no indicative files)' };
}


// Main deployment orchestration function
async function performActualDeployment(
  userId: string, 
  formData: FormData,
  parentDeploymentId: string 
): Promise<DeploymentResult> {
  const internalLogs: string[] = [];
  const logPrefix = `[performActualDeployment:${parentDeploymentId}]`;
  internalLogs.push(`--- ${logPrefix} Process Started for user: ${userId} ---`);

  let uniqueTempIdDir: string | null = null;
  let finalProjectNameForErrorHandling = 'untitled-project-setup-phase';
  let baseSourcePath = ''; // Path to the extracted/cloned root

  try {
    internalLogs.push(`${logPrefix} [Step 1/8] Validating S3 config and creating temp directories...`);
    s3Client(); // Check for S3 config presence
    if (!OLA_S3_BUCKET_NAME) {
        throw new MissingS3ConfigError('S3 bucket name (OLA_S3_BUCKET_NAME) is not configured.');
    }
    await ensureDirectoryExists(TEMP_UPLOAD_DIR, internalLogs, "TempUploadDirSetup");
    const uniqueIdSuffix = Math.random().toString(36).substring(2, 9);
    uniqueTempIdDir = path.join(TEMP_UPLOAD_DIR, `deploy-${parentDeploymentId.substring(0,15)}-${uniqueIdSuffix}`);
    await ensureDirectoryExists(uniqueTempIdDir, internalLogs, "UniqueTempDirSetup");
    internalLogs.push(`${logPrefix} Unique temporary directory: ${uniqueTempIdDir}`);

    const githubUrl = formData.get('githubUrl') as string | null;
    const file = formData.get('zipfile') as File | null;
    let sourceNameForProject = 'untitled-project';
    
    internalLogs.push(`${logPrefix} [Step 2/8] Processing project source...`);
    if (githubUrl) {
      internalLogs.push(`${logPrefix} GitHub URL provided: ${githubUrl}`);
      baseSourcePath = path.join(uniqueTempIdDir, 'cloned_repo'); 
      await ensureDirectoryExists(baseSourcePath, internalLogs, "GitCloneDirSetup");
      internalLogs.push(`${logPrefix} Attempting to clone ${githubUrl} into ${baseSourcePath}...`);
      try {
        const cloneOutput = await execAsync(`git clone --depth 1 ${githubUrl} .`, { cwd: baseSourcePath });
        if (cloneOutput.stdout) internalLogs.push(`${logPrefix} Git clone stdout:\n${cloneOutput.stdout}`);
        if (cloneOutput.stderr) internalLogs.push(`${logPrefix} Git clone stderr (may not be an error):\n${cloneOutput.stderr}`);
        internalLogs.push(`${logPrefix} Repository cloned successfully into ${baseSourcePath}.`);
        sourceNameForProject = githubUrl;
      } catch (cloneError: any) {
        const errorMsg = cloneError.message || 'Unknown Git clone error';
        internalLogs.push(`${logPrefix} Error cloning repository: ${errorMsg}`);
        throw new Error(`Failed to clone repository: ${errorMsg}.`);
      }
    } else if (file) {
      internalLogs.push(`${logPrefix} ZIP file provided: ${file.name}`);
      baseSourcePath = path.join(uniqueTempIdDir, 'extracted_zip'); 
      await ensureDirectoryExists(baseSourcePath, internalLogs, "ZipExtractDirSetup");
      const fileBuffer = Buffer.from(await file.arrayBuffer());
      const zip = await JSZip.loadAsync(fileBuffer);
      let extractedFileCount = 0;
      for (const relativePathInZip in zip.files) {
        const zipEntry = zip.files[relativePathInZip];
        const localDestPath = path.join(baseSourcePath, relativePathInZip);
        if (!localDestPath.startsWith(baseSourcePath + path.sep) && localDestPath !== baseSourcePath) {
            internalLogs.push(`${logPrefix} WARNING: Skipping potentially unsafe path in ZIP: ${relativePathInZip}`);
            continue;
        }
        if (zipEntry.dir) {
          await ensureDirectoryExists(localDestPath, internalLogs, "ZipDirCreationInLoop");
        } else {
          const content = await zipEntry.async('nodebuffer');
          await ensureDirectoryExists(path.dirname(localDestPath), internalLogs, "ZipFileDirCreationInLoop");
          await fs.writeFile(localDestPath, content);
          extractedFileCount++;
        }
      }
      internalLogs.push(`${logPrefix} ZIP extracted to ${baseSourcePath}. Files extracted: ${extractedFileCount}`);
      if (extractedFileCount === 0) throw new Error('The uploaded ZIP file is empty or contains only directories.');
      sourceNameForProject = file.name;
    } else {
      throw new Error('No file or GitHub URL provided.'); // Should be caught by deployProject
    }

    internalLogs.push(`${logPrefix} [Step 3/8] Sanitizing project name from: ${sourceNameForProject}`);
    const finalProjectName = sanitizeName(sourceNameForProject) || `web-deploy-${parentDeploymentId.substring(7, 12)}`;
    finalProjectNameForErrorHandling = finalProjectName;
    internalLogs.push(`${logPrefix} Using project name: ${finalProjectName}`);

    internalLogs.push(`${logPrefix} [Step 4/8] Determining effective project root and detecting framework...`);
    const findAnalysisFile = async (searchBaseDir: string): Promise<{filePath: string | null, content: string | null, relativePath: string | null, effectiveProjectRoot: string}> => {
      const packageJsonPaths: string[] = [];
      const indexHtmlPaths: string[] = [];
      const findFilesRecursive = async (dir: string, currentRelativeDir: string) => {
        const entries = await fs.readdir(dir, { withFileTypes: true });
        for (const entry of entries) {
          const fullPath = path.join(dir, entry.name);
          const newRelativePath = path.join(currentRelativeDir, entry.name);
          if (entry.isDirectory()) {
            if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
            await findFilesRecursive(fullPath, newRelativePath);
          } else if (entry.name.toLowerCase() === 'package.json') {
            packageJsonPaths.push(newRelativePath);
          } else if (entry.name.toLowerCase() === 'index.html') {
             if (!newRelativePath.includes('/build/') && !newRelativePath.includes('/dist/')) { 
                indexHtmlPaths.push(newRelativePath);
            }
          }
        }
      };
      await findFilesRecursive(searchBaseDir, ''); 
      packageJsonPaths.sort((a, b) => a.split(path.sep).length - b.split(path.sep).length);
      indexHtmlPaths.sort((a, b) => a.split(path.sep).length - b.split(path.sep).length);

      if (packageJsonPaths.length > 0) {
        const chosenFileRelative = packageJsonPaths[0];
        const determinedEffectiveRoot = path.join(searchBaseDir, path.dirname(chosenFileRelative));
        internalLogs.push(`${logPrefix}:findAnalysisFile] Found package.json at relative path '${chosenFileRelative}'. Effective project root set to: ${determinedEffectiveRoot}`);
        return { filePath: path.join(searchBaseDir, chosenFileRelative), content: await fs.readFile(path.join(searchBaseDir, chosenFileRelative), 'utf-8'), relativePath: chosenFileRelative, effectiveProjectRoot: determinedEffectiveRoot };
      }
      if (indexHtmlPaths.length > 0) {
         const chosenFileRelative = indexHtmlPaths[0];
         const determinedEffectiveRoot = path.join(searchBaseDir, path.dirname(chosenFileRelative));
         internalLogs.push(`${logPrefix}:findAnalysisFile] Found index.html at relative path '${chosenFileRelative}'. Effective project root set to: ${determinedEffectiveRoot}`);
         return { filePath: path.join(searchBaseDir, chosenFileRelative), content: await fs.readFile(path.join(searchBaseDir, chosenFileRelative), 'utf-8'), relativePath: chosenFileRelative, effectiveProjectRoot: determinedEffectiveRoot };
      }
      internalLogs.push(`${logPrefix}:findAnalysisFile] No package.json or suitable index.html found within '${searchBaseDir}'. Defaulting effective project root to: ${searchBaseDir}`);
      return { filePath: null, content: null, relativePath: null, effectiveProjectRoot: searchBaseDir };
    };
    
    const analysisResult = await findAnalysisFile(baseSourcePath);
    const effectiveProjectRoot = analysisResult.effectiveProjectRoot; 
    internalLogs.push(`${logPrefix} Effective project root for operations: ${effectiveProjectRoot}`);

    let frameworkDetectionResult: FrameworkDetectionResult;
    if (analysisResult.relativePath && analysisResult.content) {
        internalLogs.push(`${logPrefix} Framework detection using file: '${analysisResult.relativePath}' (relative to extraction/clone root).`);
        frameworkDetectionResult = nonAIDetectFramework(analysisResult.content, analysisResult.relativePath, internalLogs);
    } else {
        internalLogs.push(`${logPrefix} No specific analysis file found. Assuming static.`);
        frameworkDetectionResult = nonAIDetectFramework(null, 'none_found_in_search', internalLogs);
    }
    internalLogs.push(`${logPrefix} Detected framework: ${frameworkDetectionResult.framework}. Build cmd: ${frameworkDetectionResult.build_command || 'N/A'}. Output dir: ${frameworkDetectionResult.output_directory || 'N/A'}.`);

    const needsBuild = frameworkDetectionResult.framework !== 'static' && frameworkDetectionResult.build_command;
    let sourcePathForUpload = effectiveProjectRoot; 

    if (needsBuild && frameworkDetectionResult.build_command) {
      internalLogs.push(`${logPrefix} [Step 5/8] Project requires build. Starting build process...`);
      
      internalLogs.push(`${logPrefix} Running 'npm install --legacy-peer-deps --prefer-offline --no-audit --progress=false' in ${effectiveProjectRoot}...`);
      try {
        const installOutput = await execAsync('npm install --legacy-peer-deps --prefer-offline --no-audit --progress=false', { cwd: effectiveProjectRoot });
        if(installOutput.stdout) internalLogs.push(`${logPrefix} npm install stdout:\n${installOutput.stdout}`);
        if(installOutput.stderr) internalLogs.push(`${logPrefix} npm install stderr (may not be error):\n${installOutput.stderr}`);
        internalLogs.push(`${logPrefix} npm install completed.`);
      } catch (installError: any) {
        const errorMsg = installError.message || 'Unknown npm install error';
        internalLogs.push(`${logPrefix} npm install FAILED: ${errorMsg}`);
        if (installError.stdout) internalLogs.push(`${logPrefix} npm install stdout (on error):\n${installError.stdout}`);
        if (installError.stderr) internalLogs.push(`${logPrefix} npm install stderr (on error):\n${installError.stderr}`);
        throw new Error(`npm install failed: ${errorMsg}. Check project dependencies and logs.`);
      }
      
      let buildCommandToExecute = frameworkDetectionResult.build_command;
      const buildEnv = { ...process.env };
      const publicUrlForAssets = `/sites/users/${userId}/sites/${finalProjectName}`; 

      if (['cra', 'generic-react', 'vite-react'].includes(frameworkDetectionResult.framework)) {
          buildEnv.PUBLIC_URL = publicUrlForAssets; // For CRA and generic if they use it
            if (frameworkDetectionResult.framework === 'vite-react') {
              if (!buildCommandToExecute.includes('--base')) {
                const viteBasePath = publicUrlForAssets.endsWith('/') ? publicUrlForAssets : `${publicUrlForAssets}/`;
                buildCommandToExecute = `${buildCommandToExecute.replace(/vite build/, `vite build --base=${viteBasePath}`)}`;
                internalLogs.push(`${logPrefix} Adjusted Vite build command for base path: '${buildCommandToExecute}'`);
              }
            }
            internalLogs.push(`${logPrefix} Setting PUBLIC_URL or equivalent for build: ${publicUrlForAssets}`);
      }
      
      internalLogs.push(`${logPrefix} Executing build command: '${buildCommandToExecute}' in ${effectiveProjectRoot}`);
      try {
        const buildOutput = await execAsync(buildCommandToExecute, { cwd: effectiveProjectRoot, env: buildEnv });
        if(buildOutput.stdout) internalLogs.push(`${logPrefix} Build command stdout:\n${buildOutput.stdout}`);
        if(buildOutput.stderr) internalLogs.push(`${logPrefix} Build command stderr (may not be error):\n${buildOutput.stderr}`);
        internalLogs.push(`${logPrefix} Build command SUCCEEDED.`);
      } catch (buildError: any) {
        const errorMsg = buildError.message || 'Unknown build error';
        internalLogs.push(`${logPrefix} Build command FAILED: ${errorMsg}`);
        if (buildError.stdout) internalLogs.push(`${logPrefix} Build command stdout (on error):\n${buildError.stdout}`);
        if (buildError.stderr) internalLogs.push(`${logPrefix} Build command stderr (on error):\n${buildError.stderr}`);
        // AI Fix logic removed for this version. Directly throw.
        throw new Error(`Project build failed: ${errorMsg}`);
      }
      
      // Determine build output path
      const detectedOutputDirName = frameworkDetectionResult.output_directory;
      let foundBuildOutputDir = '';
      if (detectedOutputDirName) {
          const potentialPath = path.join(effectiveProjectRoot, detectedOutputDirName);
          try {
              await fs.access(potentialPath); 
              if ((await fs.stat(potentialPath)).isDirectory()) { 
                  foundBuildOutputDir = potentialPath;
                  internalLogs.push(`${logPrefix} Build output successfully found at primary path: ${foundBuildOutputDir}`);
              }
          } catch { /* path does not exist or not a dir */ }
      }

      if (!foundBuildOutputDir) {
        const commonOutputDirs = ['dist', 'build', 'out', '.next', 'public', '.output/public', '.svelte-kit/output/client'];
        internalLogs.push(`${logPrefix} Primary build output directory '${detectedOutputDirName || 'N/A'}' not confirmed. Fallback searching: ${commonOutputDirs.join(', ')} in ${effectiveProjectRoot}`);
        for (const dir of commonOutputDirs) {
          if (detectedOutputDirName === dir && !foundBuildOutputDir) continue; 
          const potentialPath = path.join(effectiveProjectRoot, dir);
          try {
            await fs.access(potentialPath);
            if ((await fs.stat(potentialPath)).isDirectory()) {
                foundBuildOutputDir = potentialPath;
                internalLogs.push(`${logPrefix} Found build output directory (fallback search) at: ${foundBuildOutputDir}`);
                break;
            }
          } catch { /* Directory does not exist */ }
        }
      }
      if (!foundBuildOutputDir) {
        throw new Error(`Build output directory not found in ${effectiveProjectRoot} after build. Expected: '${detectedOutputDirName || 'various defaults'}'. Check build logs for actual output location.`);
      }
      sourcePathForUpload = foundBuildOutputDir;
      internalLogs.push(`${logPrefix} [Step 6/8] Build successful. Source for S3 upload: ${sourcePathForUpload}`);

    } else {
      internalLogs.push(`${logPrefix} [Step 5-6/8] Static site or no build command. Using project root '${effectiveProjectRoot}' for S3 upload.`);
      sourcePathForUpload = effectiveProjectRoot; // Already set, but for clarity
    }

    internalLogs.push(`${logPrefix} [Step 7/8] Uploading files from ${sourcePathForUpload} to S3...`);
    const s3ProjectBaseKey = `users/${userId}/sites/${finalProjectName}`; 
    await uploadDirectoryRecursiveS3(sourcePathForUpload, s3ProjectBaseKey, internalLogs);
    internalLogs.push(`${logPrefix} Files uploaded successfully to S3.`);

    const deployedUrl = `/sites/${s3ProjectBaseKey}/`; 
    internalLogs.push(`${logPrefix} [Step 8/8] Deployment successful! Site should be accessible at: ${deployedUrl}`);
    internalLogs.push(`--- ${logPrefix} Process Finished Successfully ---`);

    const clientSuccessLogs = internalLogs.length > MAX_LOG_LINES_TO_CLIENT
      ? [
          `${logPrefix} Success! (Server logs trimmed for client view, showing last ${MAX_LOG_LINES_TO_CLIENT} of ${internalLogs.length} total lines. Full logs on server.)`,
          ...internalLogs.slice(-MAX_LOG_LINES_TO_CLIENT)
        ]
      : internalLogs;

    return {
      success: true,
      message: 'Project deployed successfully!',
      projectName: finalProjectName,
      deployedUrl,
      logs: clientSuccessLogs,
    };

  } catch (error: any) {
    const errorDetail = extractErrorMessage(error);
    const errorName = error instanceof Error ? error.name : "UnknownErrorInPerformActualDeployment";
    console.error(`${logPrefix} CRITICAL FAILURE. Project: ${finalProjectNameForErrorHandling}. Error (${errorName}): ${errorDetail}`, error.stack || error);
    internalLogs.push(`\n--- ${logPrefix} DEPLOYMENT FAILED ---`);
    internalLogs.push(`Error Type: ${errorName}`);
    internalLogs.push(`Error Message: ${errorDetail}`);
     if (error instanceof Error && error.stack) {
        internalLogs.push(`Stack Trace (condensed for server log):\n${error.stack.substring(0, 500)}...`);
    }
    
    const clientErrorLogs: string[] = [
        `${logPrefix} Deployment error for project: ${finalProjectNameForErrorHandling}.`,
        `Details: ${errorDetail} (Incident ID: ${parentDeploymentId})`,
    ];
     if (error instanceof MissingS3ConfigError) {
      clientErrorLogs.push("This may be due to missing S3 configuration. Please check server environment variables.");
    }
    clientErrorLogs.push("Check full server logs for more details using the incident ID.");

    return {
        success: false,
        message: `Deployment failed: ${errorDetail}`, 
        projectName: finalProjectNameForErrorHandling || 'error-handling-project',
        error: errorDetail, 
        logs: clientErrorLogs,
    };
  } finally {
    const logFinallyPrefix = `${logPrefix}:Finally]`;
    internalLogs.push(`${logFinallyPrefix} Process reached 'finally' block.`);
    if (uniqueTempIdDir && uniqueTempIdDir.startsWith(TEMP_UPLOAD_DIR) && uniqueTempIdDir !== TEMP_UPLOAD_DIR) {
      try {
        internalLogs.push(`${logFinallyPrefix} Attempting to delete temporary directory: ${uniqueTempIdDir}`);
        await fs.rm(uniqueTempIdDir, { recursive: true, force: true });
        internalLogs.push(`${logFinallyPrefix} Successfully deleted temporary directory: ${uniqueTempIdDir}`);
      } catch (cleanupError: any) {
        const cleanupMessage = `${logFinallyPrefix} Error during cleanup of ${uniqueTempIdDir}: ${extractErrorMessage(cleanupError)}`;
        internalLogs.push(cleanupMessage);
        console.error(cleanupMessage, (cleanupError as Error).stack);
      }
    } else {
       internalLogs.push(`${logFinallyPrefix} Skipped deletion of temp directory (path issue or not set): ${uniqueTempIdDir || 'Not Set'}`);
    }
  }
}

// Top-level Server Action
export async function deployProject(formData: FormData): Promise<DeploymentResult> {
  const actionDeploymentId = `action-${Date.now()}-${Math.random().toString(36).substring(2, 7)}`;
  const actionLogPrefix = `[deployProject:${actionDeploymentId}]`;
  
  let initialProjectNameForError = 'unknown-project-early-error';
  let resultForReturn: DeploymentResult = { // Initialize with a default error structure
    success: false,
    message: `Deployment action (ID: ${actionDeploymentId}) initiated but an unexpected error occurred before main processing.`,
    projectName: initialProjectNameForError,
    error: 'Pre-processing error or unhandled exception in deployment action. Check server logs.',
    logs: [`${actionLogPrefix} Error: Action did not complete. Incident ID: ${actionDeploymentId}`],
  };

  try {
    console.log(`${actionLogPrefix} Entered function. Validating input...`);
    const file = formData.get('zipfile') as File | null;
    const githubUrl = formData.get('githubUrl') as string | null;

    if (file) {
        initialProjectNameForError = sanitizeName(file.name) || `zipfile-default-name-${actionDeploymentId.substring(0,5)}`;
        console.log(`${actionLogPrefix} Source: ZIP file - Name='${file.name}', Size=${file.size}, Type='${file.type}'`);
        if (!file.name.toLowerCase().endsWith('.zip') && file.type !== 'application/zip' && file.type !== 'application/x-zip-compressed') {
            const errorMsg = `Invalid file type: "${file.name}". Only .zip files are allowed. Detected type: ${file.type}.`;
            console.error(`${actionLogPrefix} Input validation CRITICAL: ${errorMsg}`);
            return { 
                success: false, 
                message: errorMsg, 
                projectName: initialProjectNameForError, 
                error: errorMsg, 
                logs: [`${actionLogPrefix} Validation Error: ${errorMsg}`]
            };
        }
    } else if (githubUrl) {
        initialProjectNameForError = sanitizeName(githubUrl) || `github-default-name-${actionDeploymentId.substring(0,5)}`;
        console.log(`${actionLogPrefix} Source: GitHub URL - '${githubUrl}'`);
         if (!githubUrl.match(/^(https?:\/\/)?(www\.)?github\.com\/[\w-]+\/[\w.-]+(\.git)?$/i)) {
            const errorMsg = `Invalid GitHub URL format: ${githubUrl}. Expected format like 'https://github.com/user/repo'.`;
            console.error(`${actionLogPrefix} Input validation CRITICAL: ${errorMsg}`);
             return { 
                success: false, 
                message: errorMsg, 
                projectName: initialProjectNameForError, 
                error: errorMsg, 
                logs: [`${actionLogPrefix} Validation Error: ${errorMsg}`]
            };
        }
    } else {
        initialProjectNameForError = 'no-source-provided';
         const errorMsg = "No ZIP file or GitHub URL provided. Please provide one source.";
         console.error(`${actionLogPrefix} Input validation CRITICAL: ${errorMsg}`);
         return { 
            success: false, 
            message: errorMsg, 
            projectName: initialProjectNameForError, 
            error: errorMsg, 
            logs: [`${actionLogPrefix} Validation Error: ${errorMsg}`]
        };
    }
    resultForReturn.projectName = initialProjectNameForError; // Update default error with a better project name

    console.log(`${actionLogPrefix} Input validated. Calling performActualDeployment for user 'default-user', project context: '${initialProjectNameForError}', parentId: '${actionDeploymentId}'...`);
    
    const fullDeploymentOutcome = await performActualDeployment('default-user', formData, actionDeploymentId);
    
    if (
        fullDeploymentOutcome &&
        typeof fullDeploymentOutcome.success === 'boolean' &&
        typeof fullDeploymentOutcome.message === 'string' &&
        Array.isArray(fullDeploymentOutcome.logs)
    ) {
        resultForReturn = fullDeploymentOutcome;
    } else {
        const malformedResponseStr = JSON.stringify(fullDeploymentOutcome).substring(0, 200);
        console.error(`${actionLogPrefix} CRITICAL: performActualDeployment returned an invalid or malformed structure. Response (partial): ${malformedResponseStr}`);
        resultForReturn = {
            success: false,
            message: `Deployment process for '${initialProjectNameForError}' failed due to an internal server error (malformed core result).`,
            projectName: initialProjectNameForError,
            error: 'Internal server error: Malformed result from core deployment. Check server logs.',
            logs: [
                `${actionLogPrefix} Critical: Core deployment function returned malformed data.`,
                `${actionLogPrefix} Received (partial): ${malformedResponseStr}...`,
                `Incident ID: ${actionDeploymentId}`,
                `Project Context: ${initialProjectNameForError}`
            ],
        };
    }
    console.log(`${actionLogPrefix} performActualDeployment processing finished. Apparent Success: ${resultForReturn.success}, Project: '${resultForReturn.projectName}'`);

  } catch (error: any) {
    const errorMsg = extractErrorMessage(error);
    const errorName = error instanceof Error ? error.name : "UnknownErrorInDeployProjectMainCatch";
    console.error(`${actionLogPrefix} CRITICAL UNHANDLED error in deployProject's main try block. Error (${errorName}) for project '${initialProjectNameForError}': ${errorMsg}`, error instanceof Error ? error.stack : error);
    
    resultForReturn = {
        success: false,
        message: `Deployment process for '${initialProjectNameForError}' encountered a critical server error: ${errorMsg}. (Incident: ${actionDeploymentId})`,
        projectName: initialProjectNameForError,
        error: errorMsg, 
        logs: [
            `${actionLogPrefix} Critical server error: ${errorMsg}`,
            `${actionLogPrefix} Project context: '${initialProjectNameForError}'`,
            `${actionLogPrefix} Incident ID: '${actionDeploymentId}'`,
            `${actionLogPrefix} Please check detailed server logs.`
        ],
    };
  } finally {
    try {
      const finalResultToLog = resultForReturn || { success: false, message: "Result object was unexpectedly null/undefined in finally block."};
      console.log(`${actionLogPrefix} Final result being returned to client (Incident ID: ${actionDeploymentId}): Success=${finalResultToLog.success}, Msg=${(finalResultToLog.message || '').substring(0,150)}..., Project='${(finalResultToLog as DeploymentResult).projectName || initialProjectNameForError}'`);
    } catch (loggingError: any) {
        console.error(`${actionLogPrefix} CRITICAL: Could not serialize or log final result in 'finally' block. Error: ${extractErrorMessage(loggingError)}. Incident ID: ${actionDeploymentId}`);
    }
  }
  
  return resultForReturn; 
}

