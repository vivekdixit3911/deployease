
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
import { initializeDeployment, addLog, updateStatus, setDeploymentComplete, deploymentStates } from '@/lib/deploymentStore';

const execAsync = promisify(exec);

interface FrameworkDetectionResult {
  framework: string;
  build_command?: string;
  output_directory?: string;
  reasoning?: string;
}

export interface InitialDeploymentResponse {
  success: boolean;
  deploymentId?: string;
  message: string;
}

interface FullDeploymentResultForStore {
  success: boolean;
  message: string;
  projectName?: string;
  deployedUrl?: string;
  error?: string;
}

async function ensureDirectoryExists(dirPath: string, deploymentId: string, step: string) {
  addLog(deploymentId, `[${step}] Ensuring directory exists: ${dirPath}`);
  try {
    await fs.mkdir(dirPath, { recursive: true });
    addLog(deploymentId, `[${step}] Successfully ensured directory exists: ${dirPath}`);
  } catch (error: any) {
    const errorMsg = `[${step}] Failed to create directory ${dirPath}: ${error.message}`;
    addLog(deploymentId, errorMsg);
    console.error(`[${deploymentId}] ${errorMsg}`, error);
    throw new Error(errorMsg); // Re-throw to be caught by performFullDeployment's main try-catch
  }
}

async function uploadDirectoryRecursiveS3(
  localDirPath: string,
  s3BaseKey: string,
  deploymentId: string
) {
  addLog(deploymentId, `[S3 Upload] Starting upload from ${localDirPath} to S3 base key s3://${OLA_S3_BUCKET_NAME}/${s3BaseKey}`);
  if (!OLA_S3_BUCKET_NAME) {
    const errorMsg = '[S3 Upload] Error: OLA_S3_BUCKET_NAME is not configured for S3 upload.';
    addLog(deploymentId, errorMsg);
    throw new MissingS3ConfigError(errorMsg);
  }
  const currentS3Client = s3Client(); // This can throw MissingS3ConfigError if S3 not configured

  const entries = await fs.readdir(localDirPath, { withFileTypes: true });
  for (const entry of entries) {
    const localEntryPath = path.join(localDirPath, entry.name);
    const cleanEntryName = entry.name.replace(/^\/+|\/+$/g, '');
    const s3ObjectKey = `${s3BaseKey}/${cleanEntryName}`.replace(/^\/+|\/+$/g, '').replace(/\/\//g, '/');

    if (entry.isDirectory()) {
      addLog(deploymentId, `[S3 Upload] Recursively uploading directory contents of ${localEntryPath} under S3 key prefix ${s3ObjectKey}`);
      await uploadDirectoryRecursiveS3(localEntryPath, s3ObjectKey, deploymentId);
    } else {
      addLog(deploymentId, `[S3 Upload] Uploading file ${localEntryPath} to S3: s3://${OLA_S3_BUCKET_NAME}/${s3ObjectKey}...`);
      const fileBuffer = await fs.readFile(localEntryPath);
      const contentType = mime.lookup(entry.name) || 'application/octet-stream';

      const command = new PutObjectCommand({
        Bucket: OLA_S3_BUCKET_NAME,
        Key: s3ObjectKey,
        Body: fileBuffer,
        ContentType: contentType,
      });
      await currentS3Client.send(command);
      addLog(deploymentId, `[S3 Upload] Uploaded ${localEntryPath} to s3://${OLA_S3_BUCKET_NAME}/${s3ObjectKey} successfully.`);
    }
  }
  addLog(deploymentId, `[S3 Upload] Finished S3 upload for directory ${localDirPath} to base key ${s3BaseKey}`);
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

function nonAIDetectFramework(packageJsonContent: string | null, fileNameAnalyzed: string, deploymentId: string): FrameworkDetectionResult {
  addLog(deploymentId, `[Framework Detection] Input file for analysis: ${fileNameAnalyzed}.`);
  if (packageJsonContent && fileNameAnalyzed.includes('package.json')) {
    addLog(deploymentId, "[Framework Detection] Analyzing package.json...");
    try {
      const pkg = JSON.parse(packageJsonContent);
      const dependencies = { ...pkg.dependencies, ...pkg.devDependencies };
      const scripts = pkg.scripts || {};

      if (dependencies.next) {
        addLog(deploymentId, "[Framework Detection] Detected Next.js.");
        return { framework: 'nextjs', build_command: scripts.build || 'next build', output_directory: '.next', reasoning: "Next.js dependency found." };
      }
      if (dependencies['@remix-run/dev'] || dependencies.remix) {
        addLog(deploymentId, "[Framework Detection] Detected Remix.");
        return { framework: 'remix', build_command: scripts.build || 'remix build', output_directory: 'public/build', reasoning: "Remix dependency found." };
      }
      if (dependencies['@sveltejs/kit']) {
        addLog(deploymentId, "[Framework Detection] Detected SvelteKit.");
        return { framework: 'sveltekit', build_command: scripts.build || 'npm run build', output_directory: '.svelte-kit/output/client', reasoning: "SvelteKit dependency found." };
      }
      if (dependencies.nuxt) {
        addLog(deploymentId, "[Framework Detection] Detected Nuxt.js.");
        return { framework: 'nuxtjs', build_command: scripts.build || 'npm run build', output_directory: '.output/public', reasoning: "Nuxt.js dependency found." };
      }
      if (dependencies.astro) {
        addLog(deploymentId, "[Framework Detection] Detected Astro.");
        return { framework: 'astro', build_command: scripts.build || 'npm run build', output_directory: 'dist', reasoning: "Astro dependency found." };
      }
       if (dependencies.vite && (dependencies['@vitejs/plugin-react'] || dependencies['@vitejs/plugin-react-swc'])) {
        addLog(deploymentId, "[Framework Detection] Detected Vite with React.");
        return { framework: 'vite-react', build_command: scripts.build || 'vite build', output_directory: 'dist', reasoning: "Vite with React plugin detected." };
      }
       if (dependencies['react-scripts']) {
        addLog(deploymentId, "[Framework Detection] Detected Create React App.");
        return { framework: 'cra', build_command: scripts.build || 'npm run build', output_directory: 'build', reasoning: "Create React App (react-scripts) dependency found." };
      }
      if (dependencies.react && dependencies['react-dom']) {
        addLog(deploymentId, "[Framework Detection] Detected Generic React project (react and react-dom found).");
        return { framework: 'generic-react', build_command: scripts.build || 'npm run build', output_directory: 'dist', reasoning: "Generic React (react and react-dom) dependencies found." };
      }

      addLog(deploymentId, "[Framework Detection] package.json found, but no clear common framework indicators. Assuming static or custom Node.js build.");
      if (scripts.build) {
        addLog(deploymentId, `[Framework Detection] Found 'build' script: ${scripts.build}. Assuming custom build outputting to 'dist'.`);
        return { framework: 'custom-build', build_command: scripts.build, output_directory: 'dist', reasoning: "package.json with a build script, but unrecognized frontend framework. Assuming 'dist' output." };
      }
      addLog(deploymentId, "[Framework Detection] No specific framework or standard build script found in package.json. Assuming static.");
      return { framework: 'static', reasoning: "package.json present but no specific framework indicators or standard build script found." };
    } catch (e: any) {
      addLog(deploymentId, `[Framework Detection] Error parsing package.json: ${e.message}. Assuming static.`);
      return { framework: 'static', reasoning: "Failed to parse package.json." };
    }
  } else if (fileNameAnalyzed.includes('index.html')) {
    addLog(deploymentId, "[Framework Detection] No package.json prioritized. index.html found. Assuming static.");
    return { framework: 'static', reasoning: "index.html found, no package.json prioritized." };
  }

  addLog(deploymentId, "[Framework Detection] No package.json or index.html found for analysis. Assuming static.");
  return { framework: 'static', reasoning: "No definitive project files (package.json, index.html) found for analysis." };
}

function extractErrorMessage(error: any): string {
  if (error instanceof Error) {
    return error.message;
  }
  if (typeof error === 'string') {
    return error;
  }
  try {
    return JSON.stringify(error);
  } catch {
    return 'An unknown error occurred.';
  }
}

async function performFullDeployment(deploymentId: string, formData: FormData) {
  console.log(`[performFullDeployment:${deploymentId}] Starting full deployment process.`);
  updateStatus(deploymentId, 'Processing input...');
  addLog(deploymentId, '--- Deployment Process Started ---');
  
  let finalProjectName = 'untitled-project'; // Initialize early
  let uniqueTempIdDir: string | null = null; // The unique top-level temp dir for this deployment
  let projectRootPath = ''; // Path to build/upload from

  try {
    addLog(deploymentId, '[Step 1/7] Validating S3 configuration and creating temporary directories...');
    updateStatus(deploymentId, 'Validating configuration...');
    if (!OLA_S3_BUCKET_NAME) {
      throw new MissingS3ConfigError('S3 bucket name (OLA_S3_BUCKET_NAME) is not configured.');
    }
    s3Client(); // Initialize/validate S3 client (can throw MissingS3ConfigError)
    addLog(deploymentId, 'S3 client configuration appears valid.');
    
    await ensureDirectoryExists(TEMP_UPLOAD_DIR, deploymentId, "TempUploadDirSetup");
    const uniqueIdSuffix = Math.random().toString(36).substring(2, 9);
    uniqueTempIdDir = path.join(TEMP_UPLOAD_DIR, `deploy-${deploymentId.substring(0,8)}-${uniqueIdSuffix}`);
    await ensureDirectoryExists(uniqueTempIdDir, deploymentId, "UniqueTempDirSetup");
    addLog(deploymentId, `Unique temporary directory for this deployment: ${uniqueTempIdDir}`);

    const githubUrl = formData.get('githubUrl') as string | null;
    const file = formData.get('zipfile') as File | null;

    if (!file && !githubUrl) {
      throw new Error('No file uploaded and no GitHub URL provided.');
    }
    
    let sourceNameForProject = 'untitled-project';
    let baseExtractionDir = ''; // This will be the root of the extracted/cloned files

    if (githubUrl) {
      addLog(deploymentId, `[Step 2/7] Processing GitHub URL: ${githubUrl}`);
      updateStatus(deploymentId, 'Cloning repository...');
      if (!githubUrl.match(/^(https?:\/\/)?(www\.)?github\.com\/[\w-]+\/[\w.-]+(\.git)?$/i)) {
        throw new Error('Invalid GitHub URL format.');
      }
      
      baseExtractionDir = path.join(uniqueTempIdDir, 'cloned_repo');
      await ensureDirectoryExists(baseExtractionDir, deploymentId, "GitCloneDirSetup");
      addLog(deploymentId, `Attempting to clone repository from ${githubUrl} into ${baseExtractionDir}...`);
      try {
        const cloneOutput = await execAsync(`git clone --depth 1 ${githubUrl} .`, { cwd: baseExtractionDir });
        if (cloneOutput.stdout) addLog(deploymentId, `Git clone stdout:\n${cloneOutput.stdout}`);
        if (cloneOutput.stderr) addLog(deploymentId, `Git clone stderr:\n${cloneOutput.stderr}`); // stderr not always an error
        addLog(deploymentId, `Repository cloned successfully into ${baseExtractionDir}.`);
        sourceNameForProject = githubUrl;
      } catch (cloneError: any) {
        addLog(deploymentId, `Error cloning repository: ${extractErrorMessage(cloneError)}`);
        if (cloneError.stdout) addLog(deploymentId, `Git clone stdout (on error):\n${cloneError.stdout}`);
        if (cloneError.stderr) addLog(deploymentId, `Git clone stderr (on error):\n${cloneError.stderr}`);
        throw new Error(`Failed to clone repository: ${extractErrorMessage(cloneError)}`);
      }
    } else if (file) {
      addLog(deploymentId, `[Step 2/7] Processing uploaded file: ${file.name}`);
      updateStatus(deploymentId, 'Processing ZIP file...');
      if (file.type !== 'application/zip' && file.type !== 'application/x-zip-compressed') {
        throw new Error('Invalid file type. Please upload a ZIP file.');
      }
      
      const tempZipPath = path.join(uniqueTempIdDir, file.name);
      baseExtractionDir = path.join(uniqueTempIdDir, 'extracted_zip');
      await ensureDirectoryExists(baseExtractionDir, deploymentId, "ZipExtractDirSetup");
      addLog(deploymentId, `Root extraction path for ZIP: ${baseExtractionDir}`);

      const fileBuffer = Buffer.from(await file.arrayBuffer());
      await fs.writeFile(tempZipPath, fileBuffer);
      addLog(deploymentId, `Temporary ZIP file saved to: ${tempZipPath}`);
      updateStatus(deploymentId, 'Extracting ZIP file...');

      const zip = await JSZip.loadAsync(fileBuffer);
      const fileNamesInZip: string[] = [];
      addLog(deploymentId, `Extracting all ZIP files to ${baseExtractionDir}...`);
      for (const relativePathInZip in zip.files) {
        fileNamesInZip.push(relativePathInZip);
        const zipEntry = zip.files[relativePathInZip];
        const localDestPath = path.join(baseExtractionDir, relativePathInZip);
        if (zipEntry.dir) {
          await ensureDirectoryExists(localDestPath, deploymentId, "ZipDirCreation");
        } else {
          const content = await zipEntry.async('nodebuffer');
          await ensureDirectoryExists(path.dirname(localDestPath), deploymentId, "ZipFileDirCreation");
          await fs.writeFile(localDestPath, content);
        }
      }
      addLog(deploymentId, `ZIP extraction to ${baseExtractionDir} complete. Files extracted: ${fileNamesInZip.length}`);
      if (fileNamesInZip.length === 0) throw new Error('The uploaded ZIP file is empty or invalid.');
      sourceNameForProject = file.name;
    } else {
      throw new Error("No deployment source (ZIP or Git URL) provided.");
    }

    addLog(deploymentId, `[Step 3/7] Sanitizing project name from source: ${sourceNameForProject}`);
    finalProjectName = sanitizeName(sourceNameForProject) || `web-deploy-${deploymentId.substring(0, 5)}`;
    addLog(deploymentId, `Using project name: ${finalProjectName}`);
    updateStatus(deploymentId, `Project: ${finalProjectName}. Detecting framework...`);

    addLog(deploymentId, `[Step 4/7] Determining project root and detecting framework...`);
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
        addLog(deploymentId, `[findAnalysisFile] Found package.json at ${chosenFile}. Project root set to: ${determinedProjectRoot}`);
        return { filePath: path.join(searchBaseDir, chosenFile), content: await fs.readFile(path.join(searchBaseDir, chosenFile), 'utf-8'), relativePath: chosenFile, projectRoot: determinedProjectRoot };
      }
      if (indexHtmlPaths.length > 0) {
         const chosenFile = indexHtmlPaths[0];
         const determinedProjectRoot = path.join(searchBaseDir, path.dirname(chosenFile));
         addLog(deploymentId, `[findAnalysisFile] Found index.html at ${chosenFile}. Project root set to: ${determinedProjectRoot}`);
         return { filePath: path.join(searchBaseDir, chosenFile), content: await fs.readFile(path.join(searchBaseDir, chosenFile), 'utf-8'), relativePath: chosenFile, projectRoot: determinedProjectRoot };
      }
      addLog(deploymentId, `[findAnalysisFile] No package.json or suitable index.html found. Defaulting project root to: ${baseExtractionDir}`);
      return { filePath: null, content: null, relativePath: null, projectRoot: baseExtractionDir };
    };

    const analysisResult = await findAnalysisFile(baseExtractionDir, baseExtractionDir);
    projectRootPath = analysisResult.projectRoot; // This is now the path to build/upload from
    let frameworkDetectionResult: FrameworkDetectionResult;
    if (analysisResult.relativePath && analysisResult.content) {
        addLog(deploymentId, `Framework detection using file: '${analysisResult.relativePath}'. Effective project root: ${projectRootPath}`);
        frameworkDetectionResult = nonAIDetectFramework(analysisResult.content, analysisResult.relativePath, deploymentId);
    } else {
        addLog(deploymentId, `No specific analysis file found. Effective project root: ${projectRootPath}. Assuming static.`);
        frameworkDetectionResult = nonAIDetectFramework(null, 'none_found_in_search', deploymentId);
    }
    addLog(deploymentId, `Detected framework: ${frameworkDetectionResult.framework}. Build command: ${frameworkDetectionResult.build_command || 'N/A'}. Output dir: ${frameworkDetectionResult.output_directory || 'N/A'}`);
    if(frameworkDetectionResult.reasoning) addLog(deploymentId, `Reasoning: ${frameworkDetectionResult.reasoning}`);

    const needsBuild = frameworkDetectionResult.framework !== 'static' && frameworkDetectionResult.build_command;
    let buildSourcePath = projectRootPath; // For static sites or if build fails to produce distinct output dir

    if (needsBuild && frameworkDetectionResult.build_command) {
      addLog(deploymentId, `[Step 5/7] Project requires build. Starting build process in ${projectRootPath}...`);
      updateStatus(deploymentId, 'Running build process...');
      try {
        addLog(deploymentId, `Updating Browserslist database in ${projectRootPath}...`);
        updateStatus(deploymentId, 'Updating Browserslist DB...');
        try {
          const updateDbOutput = await execAsync('npx update-browserslist-db@latest --yes', { cwd: projectRootPath });
          if(updateDbOutput.stdout) addLog(deploymentId, `Browserslist update stdout: ${updateDbOutput.stdout}`);
          if(updateDbOutput.stderr) addLog(deploymentId, `Browserslist update stderr: ${updateDbOutput.stderr}`);
        } catch (updateDbError: any) {
          addLog(deploymentId, `Warning: Failed to update Browserslist database: ${extractErrorMessage(updateDbError)}. Build will proceed.`);
        }
        
        addLog(deploymentId, `Running 'npm install --legacy-peer-deps --prefer-offline --no-audit --progress=false' in ${projectRootPath}...`);
        updateStatus(deploymentId, 'Installing dependencies (npm install)...');
        const installOutput = await execAsync('npm install --legacy-peer-deps --prefer-offline --no-audit --progress=false', { cwd: projectRootPath });
        if(installOutput.stdout) addLog(deploymentId, `npm install stdout: ${installOutput.stdout}`);
        if(installOutput.stderr) addLog(deploymentId, `npm install stderr: ${installOutput.stderr}`);

        let buildCommandToExecute = frameworkDetectionResult.build_command;
        const buildEnv = { ...process.env };
        const publicUrlForAssets = `/sites/${finalProjectName}`;
        
        if (['cra', 'generic-react', 'vite-react'].includes(frameworkDetectionResult.framework)) {
            buildEnv.PUBLIC_URL = publicUrlForAssets; // For CRA, generic
            if (frameworkDetectionResult.framework === 'vite-react' && !buildCommandToExecute.includes('--base')) {
                const viteBasePath = publicUrlForAssets.endsWith('/') ? publicUrlForAssets : `${publicUrlForAssets}/`;
                buildCommandToExecute = `${buildCommandToExecute.replace(/vite build/, `vite build --base ${viteBasePath}`)}`;
                addLog(deploymentId, `Adjusted Vite build command: '${buildCommandToExecute}' with PUBLIC_URL=${publicUrlForAssets}.`);
            } else {
                addLog(deploymentId, `Setting PUBLIC_URL=${publicUrlForAssets} for build.`);
            }
        }
        
        addLog(deploymentId, `Executing build command: '${buildCommandToExecute}' in ${projectRootPath}`);
        updateStatus(deploymentId, `Building project (${buildCommandToExecute})...`);
        const buildOutput = await execAsync(buildCommandToExecute, { cwd: projectRootPath, env: buildEnv });
        if(buildOutput.stdout) addLog(deploymentId, `Build command stdout: ${buildOutput.stdout}`);
        if(buildOutput.stderr) addLog(deploymentId, `Build command stderr: ${buildOutput.stderr}`);

        const detectedOutputDirName = frameworkDetectionResult.output_directory;
        let foundBuildOutputDir = '';
        if (detectedOutputDirName) {
            const potentialPath = path.join(projectRootPath, detectedOutputDirName);
            try {
                await fs.access(potentialPath);
                if ((await fs.stat(potentialPath)).isDirectory()) {
                    foundBuildOutputDir = potentialPath;
                    addLog(deploymentId, `Build output successfully found at: ${foundBuildOutputDir}`);
                }
            } catch { /* not found */ }
        }
        if (!foundBuildOutputDir) {
          const commonOutputDirs = ['dist', 'build', 'out', '.next', 'public', '.output/public', '.svelte-kit/output/client'];
          addLog(deploymentId, `Primary build output directory '${detectedOutputDirName || 'N/A'}' not confirmed. Fallback searching: ${commonOutputDirs.join(', ')} within ${projectRootPath}`);
          for (const dir of commonOutputDirs) {
            if (detectedOutputDirName === dir && !foundBuildOutputDir) continue; 
            const potentialPath = path.join(projectRootPath, dir);
            try {
              await fs.access(potentialPath);
               if ((await fs.stat(potentialPath)).isDirectory()) {
                  foundBuildOutputDir = potentialPath;
                  addLog(deploymentId, `Found build output directory (fallback search) at: ${foundBuildOutputDir}`);
                  break;
              }
            } catch { /* Directory does not exist */ }
          }
        }
        if (!foundBuildOutputDir) {
          addLog(deploymentId, `Error: Build output directory not found in ${projectRootPath} after build. Expected: '${detectedOutputDirName || 'various defaults'}'. Uploading from project root as fallback.`);
          // buildSourcePath remains projectRootPath if no specific output dir is found
        } else {
            buildSourcePath = foundBuildOutputDir; // Set to the actual build output directory
        }
      } catch (buildError: any) {
        addLog(deploymentId, `Build process failed: ${extractErrorMessage(buildError)}`);
        if (buildError.stdout) addLog(deploymentId, `Build stdout (on error):\n${buildError.stdout}`);
        if (buildError.stderr) addLog(deploymentId, `Build stderr (on error):\n${buildError.stderr}`);
        throw buildError; // Re-throw to be caught by main try-catch
      }
    } else {
      addLog(deploymentId, `[Step 5/7] Static site or no build command. Preparing for direct upload from ${projectRootPath}.`);
      updateStatus(deploymentId, 'Preparing for static upload...');
      // buildSourcePath is already projectRootPath
    }
    
    addLog(deploymentId, `[Step 6/7] Uploading files from ${buildSourcePath} to S3...`);
    updateStatus(deploymentId, 'Uploading files to S3...');
    const s3ProjectBaseKey = `sites/${finalProjectName}`;
    await uploadDirectoryRecursiveS3(buildSourcePath, s3ProjectBaseKey, deploymentId);
    addLog(deploymentId, `Files uploaded successfully to S3.`);

    const deployedUrl = `/sites/${finalProjectName}/`;
    addLog(deploymentId, `[Step 7/7] Deployment successful! Site should be accessible at: ${deployedUrl}`);
    updateStatus(deploymentId, 'Deployment successful!');
    
    const finalResult: FullDeploymentResultForStore = {
      success: true,
      message: 'Project deployed successfully!',
      projectName: finalProjectName,
      deployedUrl,
    };
    setDeploymentComplete(deploymentId, finalResult); // This sets isDone = true
    console.log(`[performFullDeployment:${deploymentId}] SUCCESS. Project: ${finalProjectName}. URL: ${deployedUrl}`);

  } catch (error: any) {
    const errorMessage = extractErrorMessage(error);
    const errorName = error instanceof Error ? error.name : "UnknownError";
    console.error(`[performFullDeployment:${deploymentId}] CRITICAL FAILURE. Project: ${finalProjectName}. Error (${errorName}): ${errorMessage}`, error.stack || error);
    
    addLog(deploymentId, `\n--- DEPLOYMENT FAILED ---`);
    addLog(deploymentId, `Error Type: ${errorName}`);
    addLog(deploymentId, `Error Message: ${errorMessage}`);
    if (error instanceof Error && error.stack) {
        addLog(deploymentId, `Stack Trace:\n${error.stack}`);
    }
    
    updateStatus(deploymentId, `Failed: ${errorMessage.substring(0, 100)}...`);
    const finalErrorResult: FullDeploymentResultForStore = {
        success: false,
        message: `Deployment failed: ${errorMessage}`,
        projectName: finalProjectName, 
        error: errorMessage,
    };
    setDeploymentComplete(deploymentId, finalErrorResult); // This sets isDone = true
    
  } finally {
    addLog(deploymentId, `[Finally] Deployment process for ${deploymentId} reached 'finally' block.`);
    if (uniqueTempIdDir && uniqueTempIdDir.startsWith(TEMP_UPLOAD_DIR) && uniqueTempIdDir !== TEMP_UPLOAD_DIR) {
      try {
        addLog(deploymentId, `[Finally] Attempting to delete temporary directory: ${uniqueTempIdDir}`);
        await fs.rm(uniqueTempIdDir, { recursive: true, force: true });
        addLog(deploymentId, `[Finally] Successfully deleted temporary directory: ${uniqueTempIdDir}`);
      } catch (cleanupError: any) {
        const cleanupMessage = `[Finally] Error during cleanup of ${uniqueTempIdDir}: ${extractErrorMessage(cleanupError)}`;
        addLog(deploymentId, cleanupMessage);
        console.error(`[performFullDeployment:${deploymentId}] ${cleanupMessage}`, cleanupError.stack);
        // Do not re-throw from finally if main operation succeeded/failed already
      }
    } else {
       addLog(deploymentId, `[Finally] Skipped deletion of temp directory (path issue or not set): ${uniqueTempIdDir || 'Not Set'}`);
    }

    // Ensure deployment state is marked as done if not already.
    // This is a safeguard. `setDeploymentComplete` should have been called in try or catch.
    const finalState = deploymentStates.get(deploymentId);
    if (finalState && !finalState.isDone) {
        const fallbackMessage = "Deployment process concluded with an unexpected state.";
        console.warn(`[performFullDeployment:${deploymentId}] [Finally] State was not marked as done, forcing it now.`);
        addLog(deploymentId, `[Finally] Forcing deployment completion state due to unexpected termination.`);
        setDeploymentComplete(deploymentId, {
            success: false, // Assume failure if not explicitly set
            message: finalState.error || fallbackMessage,
            error: finalState.error || fallbackMessage,
            projectName: finalState.projectName || finalProjectName,
        });
    }
    addLog(deploymentId, '--- Deployment Process Finished ---');
    console.log(`[performFullDeployment:${deploymentId}] Final state isDone: ${deploymentStates.get(deploymentId)?.isDone}`);
  }
}

export async function deployProject(formData: FormData): Promise<InitialDeploymentResponse> {
  const deploymentId = `dep-${Date.now()}-${Math.random().toString(36).substring(2, 11)}`;
  console.log(`[deployProject:Action] Initiating new deployment with ID: ${deploymentId}`);
  
  initializeDeployment(deploymentId);

  // Run performFullDeployment in the background (don't await here)
  performFullDeployment(deploymentId, formData)
    .then(() => {
      console.log(`[deployProject:Action] Background task for ${deploymentId} completed its main execution path.`);
    })
    .catch((err) => {
      // This catch is for truly unhandled errors from the performFullDeployment promise itself,
      // though internal errors should be handled and logged within performFullDeployment.
      const errorMessage = extractErrorMessage(err);
      console.error(`[deployProject:Action] UNHANDLED CRITICAL error from performFullDeployment background task for ${deploymentId}:`, errorMessage, err.stack);
      addLog(deploymentId, `CRITICAL UNHANDLED ERROR in background task: ${errorMessage}`);
      setDeploymentComplete(deploymentId, { 
        success: false,
        message: `A critical unhandled error occurred in the deployment background process: ${errorMessage}`,
        error: errorMessage,
        projectName: 'unknown-project', // Project name might not be known here
      });
    });

  return {
    success: true,
    deploymentId: deploymentId,
    message: 'Deployment process initiated. Streaming updates...'
  };
}
