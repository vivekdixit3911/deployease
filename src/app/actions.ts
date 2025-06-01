
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

export interface DeploymentResult {
  success: boolean;
  message: string;
  projectName?: string;
  deployedUrl?: string;
  error?: string;
  logs: string[]; // Ensure logs is always an array of strings
}

function extractErrorMessage(error: any): string {
  const defaultMessage = 'An unknown error occurred.';
  if (!error) return defaultMessage;

  if (error instanceof Error) {
    return error.message || defaultMessage;
  }
  if (typeof error === 'string') {
    return error || defaultMessage;
  }
  try {
    const stringified = JSON.stringify(error);
    if (stringified === '{}' && Object.keys(error).length === 0) return defaultMessage;
    return stringified;
  } catch (e) {
    return `Could not stringify error object. Original error type: ${Object.prototype.toString.call(error)}. ${defaultMessage}`;
  }
}

async function ensureDirectoryExists(dirPath: string, logs: string[], step: string): Promise<void> {
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
): Promise<void> {
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

interface FrameworkDetectionResult {
  framework: string;
  build_command?: string;
  output_directory?: string;
  reasoning?: string;
}

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

async function performFullDeployment(formData: FormData): Promise<DeploymentResult> {
  const internalLogs: string[] = [];
  const deploymentIdForLogging = `deploy-${Date.now()}`;
  const logPrefix = `[performFullDeployment:${deploymentIdForLogging}]`;
  internalLogs.push(`--- ${logPrefix} Process Started ---`);
  
  let uniqueTempIdDir: string | null = null;
  let finalProjectNameForErrorHandling = 'untitled-project-setup-phase'; 

  try {
    internalLogs.push(`${logPrefix} [Step 1/7] Validating S3 config and creating temp directories...`);
    if (!OLA_S3_BUCKET_NAME) {
      internalLogs.push(`${logPrefix} CRITICAL: OLA_S3_BUCKET_NAME is not configured. Aborting.`);
      throw new MissingS3ConfigError('S3 bucket name (OLA_S3_BUCKET_NAME) is not configured.');
    }
    s3Client(); // This can throw MissingS3ConfigError if other S3 vars are missing
    internalLogs.push(`${logPrefix} S3 client configuration appears valid.`);
    
    await ensureDirectoryExists(TEMP_UPLOAD_DIR, internalLogs, "TempUploadDirSetup");
    const uniqueIdSuffix = Math.random().toString(36).substring(2, 9);
    uniqueTempIdDir = path.join(TEMP_UPLOAD_DIR, `deploy-${deploymentIdForLogging.substring(0,8)}-${uniqueIdSuffix}`);
    await ensureDirectoryExists(uniqueTempIdDir, internalLogs, "UniqueTempDirSetup");
    internalLogs.push(`${logPrefix} Unique temporary directory: ${uniqueTempIdDir}`);

    const githubUrl = formData.get('githubUrl') as string | null;
    const file = formData.get('zipfile') as File | null;

    internalLogs.push(`${logPrefix} Received file: ${file ? file.name : 'null'}, size: ${file ? file.size : 'N/A'}, type: ${file ? file.type : 'N/A'}`);
    internalLogs.push(`${logPrefix} Received githubUrl: ${githubUrl || 'null'}`);

    if (!file && !githubUrl) {
      throw new Error('No file uploaded and no GitHub URL provided.');
    }
    
    let sourceNameForProject = 'untitled-project';
    let baseExtractionDir = '';

    if (githubUrl) {
      internalLogs.push(`${logPrefix} [Step 2/7] Processing GitHub URL: ${githubUrl}`);
      if (!githubUrl.match(/^(https?:\/\/)?(www\.)?github\.com\/[\w-]+\/[\w.-]+(\.git)?$/i)) {
        throw new Error('Invalid GitHub URL format.');
      }
      
      baseExtractionDir = path.join(uniqueTempIdDir, 'cloned_repo');
      await ensureDirectoryExists(baseExtractionDir, internalLogs, "GitCloneDirSetup");
      internalLogs.push(`${logPrefix} Attempting to clone ${githubUrl} into ${baseExtractionDir}...`);
      try {
        const cloneOutput = await execAsync(`git clone --depth 1 ${githubUrl} .`, { cwd: baseExtractionDir });
        if (cloneOutput.stdout) internalLogs.push(`${logPrefix} Git clone stdout:\n${cloneOutput.stdout}`);
        if (cloneOutput.stderr) internalLogs.push(`${logPrefix} Git clone stderr (may not be an error):\n${cloneOutput.stderr}`);
        internalLogs.push(`${logPrefix} Repository cloned successfully.`);
        sourceNameForProject = githubUrl;
      } catch (cloneError: any) {
        const errorMsg = extractErrorMessage(cloneError);
        internalLogs.push(`${logPrefix} Error cloning repository: ${errorMsg}`);
        if (cloneError.stdout) internalLogs.push(`${logPrefix} Git clone stdout (on error):\n${cloneError.stdout}`);
        if (cloneError.stderr) internalLogs.push(`${logPrefix} Git clone stderr (on error):\n${cloneError.stderr}`);
        throw new Error(`Failed to clone repository: ${errorMsg}`);
      }
    } else if (file) {
      internalLogs.push(`${logPrefix} [Step 2/7] Processing uploaded file: ${file.name}, type: ${file.type}`);
      if (!file.name.toLowerCase().endsWith('.zip') && file.type !== 'application/zip' && file.type !== 'application/x-zip-compressed') {
         internalLogs.push(`${logPrefix} CRITICAL: File is not a ZIP. Name: ${file.name}, Type: ${file.type}. Aborting.`);
         throw new Error('Uploaded file is not a .zip file.');
      }
      internalLogs.push(`${logPrefix} File appears to be a ZIP file. Proceeding with extraction.`);
      
      const tempZipPath = path.join(uniqueTempIdDir, file.name);
      baseExtractionDir = path.join(uniqueTempIdDir, 'extracted_zip');
      await ensureDirectoryExists(baseExtractionDir, internalLogs, "ZipExtractDirSetup");
      internalLogs.push(`${logPrefix} Root extraction path for ZIP: ${baseExtractionDir}`);

      const fileBuffer = Buffer.from(await file.arrayBuffer());
      await fs.writeFile(tempZipPath, fileBuffer);
      internalLogs.push(`${logPrefix} Temporary ZIP file saved to: ${tempZipPath}`);

      let zip;
      try {
        zip = await JSZip.loadAsync(fileBuffer);
      } catch (zipLoadError: any) {
        internalLogs.push(`${logPrefix} CRITICAL: Failed to load ZIP file. Error: ${extractErrorMessage(zipLoadError)}`);
        throw new Error(`Invalid ZIP file: ${extractErrorMessage(zipLoadError)}`);
      }

      const fileNamesInZip: string[] = [];
      internalLogs.push(`${logPrefix} Extracting ZIP files to ${baseExtractionDir}...`);
      for (const relativePathInZip in zip.files) {
        fileNamesInZip.push(relativePathInZip);
        const zipEntry = zip.files[relativePathInZip];
        const localDestPath = path.join(baseExtractionDir, relativePathInZip);
        if (zipEntry.dir) {
          await ensureDirectoryExists(localDestPath, internalLogs, "ZipDirCreationInLoop");
        } else {
          const content = await zipEntry.async('nodebuffer');
          await ensureDirectoryExists(path.dirname(localDestPath), internalLogs, "ZipFileDirCreationInLoop");
          await fs.writeFile(localDestPath, content);
        }
      }
      internalLogs.push(`${logPrefix} ZIP extraction complete. Files extracted: ${fileNamesInZip.length}`);
      if (fileNamesInZip.length === 0) throw new Error('The uploaded ZIP file is empty or invalid after extraction attempt.');
      sourceNameForProject = file.name;
    } else { 
      throw new Error("No deployment source (ZIP or Git URL) provided.");
    }

    internalLogs.push(`${logPrefix} [Step 3/7] Sanitizing project name from: ${sourceNameForProject}`);
    const finalProjectName = sanitizeName(sourceNameForProject) || `web-deploy-${deploymentIdForLogging.substring(0, 5)}`;
    finalProjectNameForErrorHandling = finalProjectName;
    internalLogs.push(`${logPrefix} Using project name: ${finalProjectName}`);

    internalLogs.push(`${logPrefix} [Step 4/7] Determining project root and detecting framework...`);
    const findAnalysisFile = async (currentSearchPath: string, searchBaseDir: string): Promise<{filePath: string | null, content: string | null, relativePath: string | null, projectRoot: string}> => {
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
        internalLogs.push(`${logPrefix}:findAnalysisFile] Found package.json at ${chosenFile}. Project root set to: ${determinedProjectRoot}`);
        return { filePath: path.join(searchBaseDir, chosenFile), content: await fs.readFile(path.join(searchBaseDir, chosenFile), 'utf-8'), relativePath: chosenFile, projectRoot: determinedProjectRoot };
      }
      if (indexHtmlPaths.length > 0) {
         const chosenFile = indexHtmlPaths[0];
         const determinedProjectRoot = path.join(searchBaseDir, path.dirname(chosenFile));
         internalLogs.push(`${logPrefix}:findAnalysisFile] Found index.html at ${chosenFile}. Project root set to: ${determinedProjectRoot}`);
         return { filePath: path.join(searchBaseDir, chosenFile), content: await fs.readFile(path.join(searchBaseDir, chosenFile), 'utf-8'), relativePath: chosenFile, projectRoot: determinedProjectRoot };
      }
      internalLogs.push(`${logPrefix}:findAnalysisFile] No package.json or suitable index.html found. Defaulting project root to: ${baseExtractionDir}`);
      return { filePath: null, content: null, relativePath: null, projectRoot: baseExtractionDir };
    };

    const analysisResult = await findAnalysisFile(baseExtractionDir, baseExtractionDir);
    const projectRootPath = analysisResult.projectRoot;
    let frameworkDetectionResult: FrameworkDetectionResult;

    if (analysisResult.relativePath && analysisResult.content) {
        internalLogs.push(`${logPrefix} Framework detection using file: '${analysisResult.relativePath}'. Effective project root: ${projectRootPath}`);
        frameworkDetectionResult = nonAIDetectFramework(analysisResult.content, analysisResult.relativePath, internalLogs);
    } else {
        internalLogs.push(`${logPrefix} No specific analysis file found. Effective project root: ${projectRootPath}. Assuming static.`);
        frameworkDetectionResult = nonAIDetectFramework(null, 'none_found_in_search', internalLogs);
    }
    internalLogs.push(`${logPrefix} Detected framework: ${frameworkDetectionResult.framework}. Build command: ${frameworkDetectionResult.build_command || 'N/A'}. Output dir: ${frameworkDetectionResult.output_directory || 'N/A'}`);
    if(frameworkDetectionResult.reasoning) internalLogs.push(`${logPrefix} Reasoning: ${frameworkDetectionResult.reasoning}`);

    const needsBuild = frameworkDetectionResult.framework !== 'static' && frameworkDetectionResult.build_command;
    let finalBuildSourcePath = projectRootPath;

    if (needsBuild && frameworkDetectionResult.build_command) {
      internalLogs.push(`${logPrefix} [Step 5/7] Project requires build. Starting build process in ${projectRootPath}...`);
      
      internalLogs.push(`${logPrefix} Updating Browserslist database in ${projectRootPath}...`);
      try {
        const updateDbOutput = await execAsync('npx update-browserslist-db@latest --yes', { cwd: projectRootPath });
        if(updateDbOutput.stdout) internalLogs.push(`${logPrefix} Browserslist update stdout: ${updateDbOutput.stdout}`);
        if(updateDbOutput.stderr) internalLogs.push(`${logPrefix} Browserslist update stderr (may not be error): ${updateDbOutput.stderr}`);
      } catch (updateDbError: any) {
        internalLogs.push(`${logPrefix} Warning: Failed to update Browserslist database: ${extractErrorMessage(updateDbError)}. Build will proceed.`);
      }
      
      internalLogs.push(`${logPrefix} Running 'npm install --legacy-peer-deps --prefer-offline --no-audit --progress=false' in ${projectRootPath}...`);
      const installOutput = await execAsync('npm install --legacy-peer-deps --prefer-offline --no-audit --progress=false', { cwd: projectRootPath });
      if(installOutput.stdout) internalLogs.push(`${logPrefix} npm install stdout: ${installOutput.stdout}`);
      if(installOutput.stderr) internalLogs.push(`${logPrefix} npm install stderr (may not be error): ${installOutput.stderr}`);

      let buildCommandToExecute = frameworkDetectionResult.build_command;
      const buildEnv = { ...process.env };
      const publicUrlForAssets = `/sites/${finalProjectName}`;
      
      if (['cra', 'generic-react', 'vite-react'].includes(frameworkDetectionResult.framework)) {
          buildEnv.PUBLIC_URL = publicUrlForAssets;
          if (frameworkDetectionResult.framework === 'vite-react' && !buildCommandToExecute.includes('--base')) {
              const viteBasePath = publicUrlForAssets.endsWith('/') ? publicUrlForAssets : `${publicUrlForAssets}/`;
              buildCommandToExecute = `${buildCommandToExecute.replace(/vite build/, `vite build --base=${viteBasePath}`)}`; 
              internalLogs.push(`${logPrefix} Adjusted Vite build command: '${buildCommandToExecute}'`);
          } else {
              internalLogs.push(`${logPrefix} Setting PUBLIC_URL=${publicUrlForAssets} for build.`);
          }
      }
      
      internalLogs.push(`${logPrefix} Executing build command: '${buildCommandToExecute}' in ${projectRootPath} with env: ${JSON.stringify(buildEnv.PUBLIC_URL ? { PUBLIC_URL: buildEnv.PUBLIC_URL } : {})}`);
      const buildOutput = await execAsync(buildCommandToExecute, { cwd: projectRootPath, env: buildEnv });
      if(buildOutput.stdout) internalLogs.push(`${logPrefix} Build command stdout: ${buildOutput.stdout}`);
      if(buildOutput.stderr) internalLogs.push(`${logPrefix} Build command stderr (may not be error): ${buildOutput.stderr}`);

      const detectedOutputDirName = frameworkDetectionResult.output_directory;
      let foundBuildOutputDir = '';
      if (detectedOutputDirName) {
          const potentialPath = path.join(projectRootPath, detectedOutputDirName);
          try {
              await fs.access(potentialPath);
              if ((await fs.stat(potentialPath)).isDirectory()) {
                  foundBuildOutputDir = potentialPath;
                  internalLogs.push(`${logPrefix} Build output successfully found at primary path: ${foundBuildOutputDir}`);
              }
          } catch { internalLogs.push(`${logPrefix} Primary output dir '${potentialPath}' not found or not a directory.`); }
      }

      if (!foundBuildOutputDir) {
        const commonOutputDirs = ['dist', 'build', 'out', '.next', 'public', '.output/public', '.svelte-kit/output/client'];
        internalLogs.push(`${logPrefix} Primary build output directory '${detectedOutputDirName || 'N/A'}' not confirmed. Fallback searching: ${commonOutputDirs.join(', ')} within ${projectRootPath}`);
        for (const dir of commonOutputDirs) {
          if (detectedOutputDirName === dir && !foundBuildOutputDir) continue; 
          const potentialPath = path.join(projectRootPath, dir);
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
        internalLogs.push(`${logPrefix} CRITICAL: Build output directory not found in ${projectRootPath} after build. Expected: '${detectedOutputDirName || 'various defaults'}'. Attempting to upload from project root as last resort, but this is likely wrong.`);
      } else {
          finalBuildSourcePath = foundBuildOutputDir;
      }
    } else {
      internalLogs.push(`${logPrefix} [Step 5/7] Static site or no build command. Preparing for direct upload from ${projectRootPath}.`);
       if (githubUrl && frameworkDetectionResult.framework === 'static') {
        try {
          const staticDirContents = await fs.readdir(finalBuildSourcePath);
          internalLogs.push(`${logPrefix} Contents of static site source directory '${finalBuildSourcePath}' for upload: ${staticDirContents.join(', ')}`);
        } catch (readdirError: any) {
          internalLogs.push(`${logPrefix} Warning: Could not list contents of static site source directory '${finalBuildSourcePath}': ${extractErrorMessage(readdirError)}`);
        }
      }
    }
    
    internalLogs.push(`${logPrefix} [Step 6/7] Uploading files from ${finalBuildSourcePath} to S3...`);
    const s3ProjectBaseKey = `sites/${finalProjectName}`;
    await uploadDirectoryRecursiveS3(finalBuildSourcePath, s3ProjectBaseKey, internalLogs);
    internalLogs.push(`${logPrefix} Files uploaded successfully to S3.`);

    const deployedUrl = `/sites/${finalProjectName}/`; 
    internalLogs.push(`${logPrefix} [Step 7/7] Deployment successful! Site should be accessible at: ${deployedUrl}`);
    internalLogs.push(`--- ${logPrefix} Process Finished Successfully ---`);
    
    return {
      success: true,
      message: 'Project deployed successfully!',
      projectName: finalProjectName,
      deployedUrl,
      logs: internalLogs,
    };

  } catch (error: any) {
    const errorMessage = extractErrorMessage(error);
    const errorName = error instanceof Error ? error.name : "UnknownErrorInPerformFullDeployment";
    console.error(`${logPrefix} CRITICAL FAILURE. Project: ${finalProjectNameForErrorHandling}. Error (${errorName}): ${errorMessage}`, error.stack || error);
    
    internalLogs.push(`\n--- ${logPrefix} DEPLOYMENT FAILED ---`);
    internalLogs.push(`Error Type: ${errorName}`);
    internalLogs.push(`Error Message: ${errorMessage}`);
    if (error instanceof Error && error.stack) {
        internalLogs.push(`Stack Trace (condensed):\n${error.stack.substring(0, 500)}...`); // Log a condensed stack
    }
    
    return {
        success: false,
        message: `Deployment failed: ${errorMessage}`,
        projectName: finalProjectNameForErrorHandling, 
        error: errorMessage,
        logs: internalLogs,
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
        console.error(cleanupMessage, cleanupError.stack);
      }
    } else {
       internalLogs.push(`${logFinallyPrefix} Skipped deletion of temp directory (path issue or not set): ${uniqueTempIdDir || 'Not Set'}`);
    }
  }
}

export async function deployProject(formData: FormData): Promise<DeploymentResult> {
  const actionLogPrefix = "[deployProject:Action]";
  console.log(`${actionLogPrefix} Entered function.`);
  let result: DeploymentResult;

  try {
    // Log formData details for debugging
    console.log(`${actionLogPrefix} Received formData. Keys: ${Array.from(formData.keys()).join(', ')}`);
    if (formData.has('zipfile')) {
        const file = formData.get('zipfile') as File | null;
        console.log(`${actionLogPrefix} zipfile details: name=${file?.name}, size=${file?.size}, type=${file?.type}`);
         if (file && !file.name.toLowerCase().endsWith('.zip') && file.type !== 'application/zip' && file.type !== 'application/x-zip-compressed') {
            console.error(`${actionLogPrefix} CRITICAL: Client submitted a file that is not a ZIP. Name: ${file.name}, Type: ${file.type}`);
            // This case should ideally be caught client-side, but as a server safeguard:
             return {
                success: false,
                message: "Invalid file type. Only .zip files are allowed.",
                projectName: sanitizeName(file?.name),
                error: "Invalid file type. Only .zip files are allowed.",
                logs: [`${actionLogPrefix} Error: Client submitted a non-ZIP file. Name: ${file.name}, Type: ${file.type}`]
            };
        }
    } else {
        console.log(`${actionLogPrefix} zipfile field NOT found in formData.`);
    }
    if (formData.has('githubUrl')) {
        console.log(`${actionLogPrefix} githubUrl value: ${formData.get('githubUrl')}`);
    } else {
        console.log(`${actionLogPrefix} githubUrl field NOT found in formData.`);
    }
    
    console.log(`${actionLogPrefix} Calling performFullDeployment...`);
    result = await performFullDeployment(formData);
    console.log(`${actionLogPrefix} performFullDeployment returned. Success: ${result.success}`);

  } catch (error: any) { 
    const errorMsg = extractErrorMessage(error);
    const errorName = error instanceof Error ? error.name : "UnknownErrorInDeployProject";
    console.error(`${actionLogPrefix} CRITICAL unhandled error in deployProject. Error (${errorName}): ${errorMsg}`, error.stack || error);
    
    result = {
      success: false,
      message: `Deployment failed due to a critical server error: ${errorMsg}`,
      projectName: 'untitled-critical-error',
      error: errorMsg,
      logs: [
        `${actionLogPrefix} A critical unhandled error occurred in the deployment action.`,
        `Error Type: ${errorName}`,
        `Error Message: ${errorMsg}`,
      ]
    };
  }

  try {
    // Log the exact object being returned
    const resultString = JSON.stringify(result, null, 2);
    console.log(`${actionLogPrefix} Attempting to return to client: ${resultString}`);
  } catch (stringifyError: any) {
    // This means the 'result' object itself is not serializable, which is a major issue.
    console.error(`${actionLogPrefix} CRITICAL: Could not stringify the 'result' object before returning. Error: ${extractErrorMessage(stringifyError)}`, result);
    // Fallback to a very basic, guaranteed-serializable error response
    return {
        success: false,
        message: "Server encountered a critical error preparing the response. Check server logs.",
        projectName: result?.projectName || 'serialization-error',
        error: "Server response serialization error.",
        logs: result?.logs && Array.isArray(result.logs) ? [...result.logs, "Server response serialization error."] : ["Server response serialization error."]
    };
  }
  return result;
}

