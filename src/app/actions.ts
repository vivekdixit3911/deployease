
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

const execAsync = promisify(exec);

interface FrameworkDetectionResult {
  framework: string;
  build_command?: string;
  output_directory?: string;
  reasoning?: string;
}

export interface DeploymentResult {
  success: boolean;
  message: string;
  projectName?: string;
  deployedUrl?: string;
  error?: string;
  logs?: string[]; // Optional: to return logs to the client
}

function extractErrorMessage(error: any): string {
  if (!error) return 'An unknown error occurred (error object was null or undefined).';
  if (error instanceof Error) {
    let message = error.message || 'Error object had no message property.';
    return message;
  }
  if (typeof error === 'string') {
    return error;
  }
  try {
    const stringified = JSON.stringify(error);
    if (stringified === '{}') return 'An empty object was thrown as an error.';
    return stringified;
  } catch (e: any) {
    let fallbackMessage = 'Could not stringify error object due to an internal error.';
    if (e && typeof e.message === 'string') {
      fallbackMessage = `Could not stringify error object: ${e.message}`;
    }
    const errorAsString = String(error);
    if (errorAsString !== '[object Object]') {
      fallbackMessage += `. Basic error string: ${errorAsString}`;
    }
    return fallbackMessage;
  }
}

async function ensureDirectoryExists(dirPath: string, logs: string[], step: string) {
  const logPrefix = `[ensureDirectoryExists:${step}]`;
  logs.push(`${logPrefix} Ensuring directory exists: ${dirPath}`);
  try {
    await fs.mkdir(dirPath, { recursive: true });
    logs.push(`${logPrefix} Successfully ensured directory exists: ${dirPath}`);
  } catch (error: any) {
    const errorMsg = `${logPrefix} Failed to create directory ${dirPath}: ${extractErrorMessage(error)}`;
    logs.push(errorMsg);
    console.error(errorMsg, error);
    throw new Error(errorMsg);
  }
}

async function uploadDirectoryRecursiveS3(
  localDirPath: string,
  s3BaseKey: string,
  logs: string[]
) {
  const logPrefix = `[uploadDirectoryRecursiveS3]`;
  logs.push(`${logPrefix} Starting S3 upload from ${localDirPath} to s3://${OLA_S3_BUCKET_NAME}/${s3BaseKey}`);

  if (!OLA_S3_BUCKET_NAME) {
    const errorMsg = `${logPrefix} Error: OLA_S3_BUCKET_NAME is not configured.`;
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

function nonAIDetectFramework(packageJsonContent: string | null, fileNameAnalyzed: string, logs: string[]): FrameworkDetectionResult {
  const logPrefix = `[nonAIDetectFramework]`;
  logs.push(`${logPrefix} Input file for analysis: ${fileNameAnalyzed}.`);
  if (packageJsonContent && fileNameAnalyzed.includes('package.json')) {
    logs.push(`${logPrefix} Analyzing package.json...`);
    try {
      const pkg = JSON.parse(packageJsonContent);
      const dependencies = { ...pkg.dependencies, ...pkg.devDependencies };
      const scripts = pkg.scripts || {};

      if (dependencies.next) {
        logs.push(`${logPrefix} Detected Next.js.`);
        return { framework: 'nextjs', build_command: scripts.build || 'next build', output_directory: '.next', reasoning: "Next.js dependency found." };
      }
      // ... (other framework detections remain the same, ensuring logs.push for each detection)
      if (dependencies['@remix-run/dev'] || dependencies.remix) {
        logs.push(`${logPrefix} Detected Remix.`);
        return { framework: 'remix', build_command: scripts.build || 'remix build', output_directory: 'public/build', reasoning: "Remix dependency found." };
      }
      if (dependencies['@sveltejs/kit']) {
        logs.push(`${logPrefix} Detected SvelteKit.`);
        return { framework: 'sveltekit', build_command: scripts.build || 'npm run build', output_directory: '.svelte-kit/output/client', reasoning: "SvelteKit dependency found." };
      }
      if (dependencies.nuxt) {
        logs.push(`${logPrefix} Detected Nuxt.js.`);
        return { framework: 'nuxtjs', build_command: scripts.build || 'npm run build', output_directory: '.output/public', reasoning: "Nuxt.js dependency found." };
      }
      if (dependencies.astro) {
        logs.push(`${logPrefix} Detected Astro.`);
        return { framework: 'astro', build_command: scripts.build || 'npm run build', output_directory: 'dist', reasoning: "Astro dependency found." };
      }
       if (dependencies.vite && (dependencies['@vitejs/plugin-react'] || dependencies['@vitejs/plugin-react-swc'])) {
        logs.push(`${logPrefix} Detected Vite with React.`);
        return { framework: 'vite-react', build_command: scripts.build || 'vite build', output_directory: 'dist', reasoning: "Vite with React plugin detected." };
      }
       if (dependencies['react-scripts']) {
        logs.push(`${logPrefix} Detected Create React App.`);
        return { framework: 'cra', build_command: scripts.build || 'npm run build', output_directory: 'build', reasoning: "Create React App (react-scripts) dependency found." };
      }
      if (dependencies.react && dependencies['react-dom']) {
        logs.push(`${logPrefix} Detected Generic React project (react and react-dom found).`);
        return { framework: 'generic-react', build_command: scripts.build || 'npm run build', output_directory: 'dist', reasoning: "Generic React (react and react-dom) dependencies found." };
      }

      logs.push(`${logPrefix} package.json found, but no clear common framework indicators. Assuming static or custom Node.js build.`);
      if (scripts.build) {
        logs.push(`${logPrefix} Found 'build' script: ${scripts.build}. Assuming custom build outputting to 'dist'.`);
        return { framework: 'custom-build', build_command: scripts.build, output_directory: 'dist', reasoning: "package.json with a build script, but unrecognized frontend framework. Assuming 'dist' output." };
      }
      logs.push(`${logPrefix} No specific framework or standard build script found in package.json. Assuming static.`);
      return { framework: 'static', reasoning: "package.json present but no specific framework indicators or standard build script found." };
    } catch (e: any) {
      logs.push(`${logPrefix} Error parsing package.json: ${extractErrorMessage(e)}. Assuming static.`);
      return { framework: 'static', reasoning: "Failed to parse package.json." };
    }
  } else if (fileNameAnalyzed.includes('index.html')) {
    logs.push(`${logPrefix} No package.json prioritized. index.html found. Assuming static.`);
    return { framework: 'static', reasoning: "index.html found, no package.json prioritized." };
  }

  logs.push(`${logPrefix} No package.json or index.html found for analysis. Assuming static.`);
  return { framework: 'static', reasoning: "No definitive project files (package.json, index.html) found for analysis." };
}

async function performFullDeployment(formData: FormData, logs: string[]): Promise<Omit<DeploymentResult, 'logs'>> {
  const deploymentIdForLogging = `deploy-${Date.now()}`; // For internal logging correlation
  const logPrefix = `[performFullDeployment:${deploymentIdForLogging}]`;
  logs.push(`--- ${logPrefix} Process Started ---`);
  
  let uniqueTempIdDir: string | null = null;
  let finalProjectNameForErrorHandling = 'untitled-project-setup-phase'; 

  try {
    logs.push(`${logPrefix} [Step 1/7] Validating S3 config and creating temp directories...`);
    if (!OLA_S3_BUCKET_NAME) {
      throw new MissingS3ConfigError('S3 bucket name (OLA_S3_BUCKET_NAME) is not configured.');
    }
    s3Client(); 
    logs.push(`${logPrefix} S3 client configuration appears valid.`);
    
    await ensureDirectoryExists(TEMP_UPLOAD_DIR, logs, "TempUploadDirSetup");
    const uniqueIdSuffix = Math.random().toString(36).substring(2, 9);
    uniqueTempIdDir = path.join(TEMP_UPLOAD_DIR, `deploy-${deploymentIdForLogging.substring(0,8)}-${uniqueIdSuffix}`);
    await ensureDirectoryExists(uniqueTempIdDir, logs, "UniqueTempDirSetup");
    logs.push(`${logPrefix} Unique temporary directory: ${uniqueTempIdDir}`);

    const githubUrl = formData.get('githubUrl') as string | null;
    const file = formData.get('zipfile') as File | null;

    logs.push(`${logPrefix} Received file: ${file ? file.name : 'null'}, size: ${file ? file.size : 'N/A'}, type: ${file ? file.type : 'N/A'}`);
    logs.push(`${logPrefix} Received githubUrl: ${githubUrl || 'null'}`);


    if (!file && !githubUrl) {
      throw new Error('No file uploaded and no GitHub URL provided.');
    }
    
    let sourceNameForProject = 'untitled-project';
    let baseExtractionDir = '';

    if (githubUrl) {
      logs.push(`${logPrefix} [Step 2/7] Processing GitHub URL: ${githubUrl}`);
      if (!githubUrl.match(/^(https?:\/\/)?(www\.)?github\.com\/[\w-]+\/[\w.-]+(\.git)?$/i)) {
        throw new Error('Invalid GitHub URL format.');
      }
      
      baseExtractionDir = path.join(uniqueTempIdDir, 'cloned_repo');
      await ensureDirectoryExists(baseExtractionDir, logs, "GitCloneDirSetup");
      logs.push(`${logPrefix} Attempting to clone ${githubUrl} into ${baseExtractionDir}...`);
      try {
        const cloneOutput = await execAsync(`git clone --depth 1 ${githubUrl} .`, { cwd: baseExtractionDir });
        if (cloneOutput.stdout) logs.push(`${logPrefix} Git clone stdout:\n${cloneOutput.stdout}`);
        if (cloneOutput.stderr) logs.push(`${logPrefix} Git clone stderr (may not be an error):\n${cloneOutput.stderr}`);
        logs.push(`${logPrefix} Repository cloned successfully.`);
        sourceNameForProject = githubUrl;
      } catch (cloneError: any) {
        const errorMsg = extractErrorMessage(cloneError);
        logs.push(`${logPrefix} Error cloning repository: ${errorMsg}`);
        if (cloneError.stdout) logs.push(`${logPrefix} Git clone stdout (on error):\n${cloneError.stdout}`);
        if (cloneError.stderr) logs.push(`${logPrefix} Git clone stderr (on error):\n${cloneError.stderr}`);
        throw new Error(`Failed to clone repository: ${errorMsg}`);
      }
    } else if (file) {
      logs.push(`${logPrefix} [Step 2/7] Processing uploaded file: ${file.name}, type: ${file.type}`);
      // Relaxed ZIP type check, primary validation is attempting to open it
      if (!file.name.toLowerCase().endsWith('.zip')) {
         logs.push(`${logPrefix} Warning: File does not end with .zip, but attempting to process as ZIP. Type: ${file.type}`);
      }
      
      const tempZipPath = path.join(uniqueTempIdDir, file.name);
      baseExtractionDir = path.join(uniqueTempIdDir, 'extracted_zip');
      await ensureDirectoryExists(baseExtractionDir, logs, "ZipExtractDirSetup");
      logs.push(`${logPrefix} Root extraction path for ZIP: ${baseExtractionDir}`);

      const fileBuffer = Buffer.from(await file.arrayBuffer());
      await fs.writeFile(tempZipPath, fileBuffer);
      logs.push(`${logPrefix} Temporary ZIP file saved to: ${tempZipPath}`);

      let zip;
      try {
        zip = await JSZip.loadAsync(fileBuffer);
      } catch (zipLoadError: any) {
        logs.push(`${logPrefix} CRITICAL: Failed to load ZIP file. Error: ${extractErrorMessage(zipLoadError)}`);
        throw new Error(`Invalid ZIP file: ${extractErrorMessage(zipLoadError)}`);
      }

      const fileNamesInZip: string[] = [];
      logs.push(`${logPrefix} Extracting ZIP files to ${baseExtractionDir}...`);
      for (const relativePathInZip in zip.files) {
        fileNamesInZip.push(relativePathInZip);
        const zipEntry = zip.files[relativePathInZip];
        const localDestPath = path.join(baseExtractionDir, relativePathInZip);
        if (zipEntry.dir) {
          await ensureDirectoryExists(localDestPath, logs, "ZipDirCreationInLoop");
        } else {
          const content = await zipEntry.async('nodebuffer');
          await ensureDirectoryExists(path.dirname(localDestPath), logs, "ZipFileDirCreationInLoop");
          await fs.writeFile(localDestPath, content);
        }
      }
      logs.push(`${logPrefix} ZIP extraction complete. Files extracted: ${fileNamesInZip.length}`);
      if (fileNamesInZip.length === 0) throw new Error('The uploaded ZIP file is empty or invalid after extraction attempt.');
      sourceNameForProject = file.name;
    } else { 
      throw new Error("No deployment source (ZIP or Git URL) provided.");
    }

    logs.push(`${logPrefix} [Step 3/7] Sanitizing project name from: ${sourceNameForProject}`);
    const finalProjectName = sanitizeName(sourceNameForProject) || `web-deploy-${deploymentIdForLogging.substring(0, 5)}`;
    finalProjectNameForErrorHandling = finalProjectName;
    logs.push(`${logPrefix} Using project name: ${finalProjectName}`);

    logs.push(`${logPrefix} [Step 4/7] Determining project root and detecting framework...`);
    const findAnalysisFile = async (currentSearchPath: string, searchBaseDir: string): Promise<{filePath: string | null, content: string | null, relativePath: string | null, projectRoot: string}> => {
      // ... (findAnalysisFile logic remains the same, ensure logs.push for its internal steps)
      const packageJsonPaths: string[] = [];
      const indexHtmlPaths: string[] = [];
      const findFilesRecursive = async (dir: string) => {
        const entries = await fs.readdir(dir, { withFileTypes: true });
        for (const entry of entries) {
          const fullPath = path.join(dir, entry.name);
          const relativeToSearchBase = path.relative(searchBaseDir, fullPath); 
          if (entry.isDirectory()) {
            if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
            await findFilesRecursive(fullPath);
          } else if (entry.name.toLowerCase() === 'package.json') {
            packageJsonPaths.push(relativeToSearchBase);
          } else if (entry.name.toLowerCase() === 'index.html') {
             if (!relativeToSearchBase.includes('/build/') && !relativeToSearchBase.includes('/dist/')) { 
                indexHtmlPaths.push(relativeToSearchBase);
            }
          }
        }
      };
      await findFilesRecursive(currentSearchPath);
      packageJsonPaths.sort((a, b) => a.split(path.sep).length - b.split(path.sep).length);
      indexHtmlPaths.sort((a, b) => a.split(path.sep).length - b.split(path.sep).length);

      if (packageJsonPaths.length > 0) {
        const chosenFile = packageJsonPaths[0];
        const determinedProjectRoot = path.join(searchBaseDir, path.dirname(chosenFile));
        logs.push(`${logPrefix}:findAnalysisFile] Found package.json at ${chosenFile}. Project root set to: ${determinedProjectRoot}`);
        return { filePath: path.join(searchBaseDir, chosenFile), content: await fs.readFile(path.join(searchBaseDir, chosenFile), 'utf-8'), relativePath: chosenFile, projectRoot: determinedProjectRoot };
      }
      if (indexHtmlPaths.length > 0) {
         const chosenFile = indexHtmlPaths[0];
         const determinedProjectRoot = path.join(searchBaseDir, path.dirname(chosenFile));
         logs.push(`${logPrefix}:findAnalysisFile] Found index.html at ${chosenFile}. Project root set to: ${determinedProjectRoot}`);
         return { filePath: path.join(searchBaseDir, chosenFile), content: await fs.readFile(path.join(searchBaseDir, chosenFile), 'utf-8'), relativePath: chosenFile, projectRoot: determinedProjectRoot };
      }
      logs.push(`${logPrefix}:findAnalysisFile] No package.json or suitable index.html found. Defaulting project root to: ${baseExtractionDir}`);
      return { filePath: null, content: null, relativePath: null, projectRoot: baseExtractionDir };
    };

    const analysisResult = await findAnalysisFile(baseExtractionDir, baseExtractionDir);
    const projectRootPath = analysisResult.projectRoot;
    let frameworkDetectionResult: FrameworkDetectionResult;

    if (analysisResult.relativePath && analysisResult.content) {
        logs.push(`${logPrefix} Framework detection using file: '${analysisResult.relativePath}'. Effective project root: ${projectRootPath}`);
        frameworkDetectionResult = nonAIDetectFramework(analysisResult.content, analysisResult.relativePath, logs);
    } else {
        logs.push(`${logPrefix} No specific analysis file found. Effective project root: ${projectRootPath}. Assuming static.`);
        frameworkDetectionResult = nonAIDetectFramework(null, 'none_found_in_search', logs);
    }
    logs.push(`${logPrefix} Detected framework: ${frameworkDetectionResult.framework}. Build command: ${frameworkDetectionResult.build_command || 'N/A'}. Output dir: ${frameworkDetectionResult.output_directory || 'N/A'}`);
    if(frameworkDetectionResult.reasoning) logs.push(`${logPrefix} Reasoning: ${frameworkDetectionResult.reasoning}`);

    const needsBuild = frameworkDetectionResult.framework !== 'static' && frameworkDetectionResult.build_command;
    let finalBuildSourcePath = projectRootPath;

    if (needsBuild && frameworkDetectionResult.build_command) {
      logs.push(`${logPrefix} [Step 5/7] Project requires build. Starting build process in ${projectRootPath}...`);
      
      logs.push(`${logPrefix} Updating Browserslist database in ${projectRootPath}...`);
      try {
        const updateDbOutput = await execAsync('npx update-browserslist-db@latest --yes', { cwd: projectRootPath });
        if(updateDbOutput.stdout) logs.push(`${logPrefix} Browserslist update stdout: ${updateDbOutput.stdout}`);
        if(updateDbOutput.stderr) logs.push(`${logPrefix} Browserslist update stderr (may not be error): ${updateDbOutput.stderr}`);
      } catch (updateDbError: any) {
        logs.push(`${logPrefix} Warning: Failed to update Browserslist database: ${extractErrorMessage(updateDbError)}. Build will proceed.`);
      }
      
      logs.push(`${logPrefix} Running 'npm install --legacy-peer-deps --prefer-offline --no-audit --progress=false' in ${projectRootPath}...`);
      const installOutput = await execAsync('npm install --legacy-peer-deps --prefer-offline --no-audit --progress=false', { cwd: projectRootPath });
      if(installOutput.stdout) logs.push(`${logPrefix} npm install stdout: ${installOutput.stdout}`);
      if(installOutput.stderr) logs.push(`${logPrefix} npm install stderr (may not be error): ${installOutput.stderr}`);

      let buildCommandToExecute = frameworkDetectionResult.build_command;
      const buildEnv = { ...process.env };
      const publicUrlForAssets = `/sites/${finalProjectName}`;
      
      if (['cra', 'generic-react', 'vite-react'].includes(frameworkDetectionResult.framework)) {
          buildEnv.PUBLIC_URL = publicUrlForAssets;
          if (frameworkDetectionResult.framework === 'vite-react' && !buildCommandToExecute.includes('--base')) {
              const viteBasePath = publicUrlForAssets.endsWith('/') ? publicUrlForAssets : `${publicUrlForAssets}/`;
              buildCommandToExecute = `${buildCommandToExecute.replace(/vite build/, `vite build --base=${viteBasePath}`)}`; 
              logs.push(`${logPrefix} Adjusted Vite build command: '${buildCommandToExecute}'`);
          } else {
              logs.push(`${logPrefix} Setting PUBLIC_URL=${publicUrlForAssets} for build.`);
          }
      }
      
      logs.push(`${logPrefix} Executing build command: '${buildCommandToExecute}' in ${projectRootPath} with env: ${JSON.stringify(buildEnv.PUBLIC_URL ? { PUBLIC_URL: buildEnv.PUBLIC_URL } : {})}`);
      const buildOutput = await execAsync(buildCommandToExecute, { cwd: projectRootPath, env: buildEnv });
      if(buildOutput.stdout) logs.push(`${logPrefix} Build command stdout: ${buildOutput.stdout}`);
      if(buildOutput.stderr) logs.push(`${logPrefix} Build command stderr (may not be error): ${buildOutput.stderr}`);

      const detectedOutputDirName = frameworkDetectionResult.output_directory;
      let foundBuildOutputDir = '';
      if (detectedOutputDirName) {
          const potentialPath = path.join(projectRootPath, detectedOutputDirName);
          try {
              await fs.access(potentialPath);
              if ((await fs.stat(potentialPath)).isDirectory()) {
                  foundBuildOutputDir = potentialPath;
                  logs.push(`${logPrefix} Build output successfully found at primary path: ${foundBuildOutputDir}`);
              }
          } catch { logs.push(`${logPrefix} Primary output dir '${potentialPath}' not found or not a directory.`); }
      }

      if (!foundBuildOutputDir) {
        const commonOutputDirs = ['dist', 'build', 'out', '.next', 'public', '.output/public', '.svelte-kit/output/client'];
        logs.push(`${logPrefix} Primary build output directory '${detectedOutputDirName || 'N/A'}' not confirmed. Fallback searching: ${commonOutputDirs.join(', ')} within ${projectRootPath}`);
        for (const dir of commonOutputDirs) {
          if (detectedOutputDirName === dir && !foundBuildOutputDir) continue; 
          const potentialPath = path.join(projectRootPath, dir);
          try {
            await fs.access(potentialPath);
             if ((await fs.stat(potentialPath)).isDirectory()) {
                foundBuildOutputDir = potentialPath;
                logs.push(`${logPrefix} Found build output directory (fallback search) at: ${foundBuildOutputDir}`);
                break;
            }
          } catch { /* Directory does not exist */ }
        }
      }

      if (!foundBuildOutputDir) {
        logs.push(`${logPrefix} CRITICAL: Build output directory not found in ${projectRootPath} after build. Expected: '${detectedOutputDirName || 'various defaults'}'. Attempting to upload from project root as last resort, but this is likely wrong.`);
      } else {
          finalBuildSourcePath = foundBuildOutputDir;
      }
    } else {
      logs.push(`${logPrefix} [Step 5/7] Static site or no build command. Preparing for direct upload from ${projectRootPath}.`);
       if (githubUrl && frameworkDetectionResult.framework === 'static') {
        try {
          const staticDirContents = await fs.readdir(finalBuildSourcePath);
          logs.push(`${logPrefix} Contents of static site source directory '${finalBuildSourcePath}' for upload: ${staticDirContents.join(', ')}`);
        } catch (readdirError: any) {
          logs.push(`${logPrefix} Warning: Could not list contents of static site source directory '${finalBuildSourcePath}': ${extractErrorMessage(readdirError)}`);
        }
      }
    }
    
    logs.push(`${logPrefix} [Step 6/7] Uploading files from ${finalBuildSourcePath} to S3...`);
    const s3ProjectBaseKey = `sites/${finalProjectName}`;
    await uploadDirectoryRecursiveS3(finalBuildSourcePath, s3ProjectBaseKey, logs);
    logs.push(`${logPrefix} Files uploaded successfully to S3.`);

    const deployedUrl = `/sites/${finalProjectName}/`; 
    logs.push(`${logPrefix} [Step 7/7] Deployment successful! Site should be accessible at: ${deployedUrl}`);
    
    return {
      success: true,
      message: 'Project deployed successfully!',
      projectName: finalProjectName,
      deployedUrl,
    };

  } catch (error: any) {
    const errorMessage = extractErrorMessage(error);
    const errorName = error instanceof Error ? error.name : "UnknownErrorInPerformFullDeployment";
    console.error(`${logPrefix} CRITICAL FAILURE. Project: ${finalProjectNameForErrorHandling}. Error (${errorName}): ${errorMessage}`, error.stack || error);
    
    logs.push(`\n--- ${logPrefix} DEPLOYMENT FAILED ---`);
    logs.push(`Error Type: ${errorName}`);
    logs.push(`Error Message: ${errorMessage}`);
    if (error instanceof Error && error.stack) {
        logs.push(`Stack Trace:\n${error.stack}`);
    }
    
    return {
        success: false,
        message: `Deployment failed: ${errorMessage}`,
        projectName: finalProjectNameForErrorHandling, 
        error: errorMessage,
    };
    
  } finally {
    const logFinallyPrefix = `${logPrefix}:Finally]`;
    logs.push(`${logFinallyPrefix} Process reached 'finally' block.`);
    if (uniqueTempIdDir && uniqueTempIdDir.startsWith(TEMP_UPLOAD_DIR) && uniqueTempIdDir !== TEMP_UPLOAD_DIR) {
      try {
        logs.push(`${logFinallyPrefix} Attempting to delete temporary directory: ${uniqueTempIdDir}`);
        await fs.rm(uniqueTempIdDir, { recursive: true, force: true });
        logs.push(`${logFinallyPrefix} Successfully deleted temporary directory: ${uniqueTempIdDir}`);
      } catch (cleanupError: any) {
        const cleanupMessage = `${logFinallyPrefix} Error during cleanup of ${uniqueTempIdDir}: ${extractErrorMessage(cleanupError)}`;
        logs.push(cleanupMessage);
        console.error(cleanupMessage, cleanupError.stack);
      }
    } else {
       logs.push(`${logFinallyPrefix} Skipped deletion of temp directory (path issue or not set): ${uniqueTempIdDir || 'Not Set'}`);
    }
    logs.push(`--- ${logPrefix} Process Finished ---`);
  }
}

export async function deployProject(formData: FormData): Promise<DeploymentResult> {
  const actionLogPrefix = "[deployProject:Action]";
  console.log(`${actionLogPrefix} Entered function.`);
  const logs: string[] = [];

  try {
    console.log(`${actionLogPrefix} Entered TRY block.`);
    logs.push(`${actionLogPrefix} Deployment process initiated.`);

    const result = await performFullDeployment(formData, logs);
    
    const response: DeploymentResult = {
      ...result,
      logs // Include logs in the final response
    };
    console.log(`${actionLogPrefix} Deployment process completed. Success: ${response.success}. Message: ${response.message}`);
    return response;

  } catch (initialError: any) {
    const errorMsg = extractErrorMessage(initialError);
    const errorName = initialError instanceof Error ? initialError.name : "UnknownInitialError";
    console.error(`${actionLogPrefix} CRITICAL error during deployProject: Name: ${errorName}, Msg: ${errorMsg}`, initialError.stack || initialError);
    
    logs.push(`${actionLogPrefix} Critical error during deployment: ${errorMsg}`);
    
    const errorResponse: DeploymentResult = {
      success: false,
      message: `Failed to complete deployment: ${errorMsg}`,
      error: errorMsg,
      logs
    };
    console.log(`${actionLogPrefix} Error during deployment, returning:`, JSON.stringify(errorResponse, null, 2));
    return errorResponse;
  }
}
