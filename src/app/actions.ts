
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
import { initializeDeployment, addLog, updateStatus, setDeploymentComplete, deploymentStates, type DeploymentProgress } from '@/lib/deploymentStore';

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
  const logPrefix = `[ensureDirectoryExists:${deploymentId}:${step}]`;
  addLog(deploymentId, `${logPrefix} Ensuring directory exists: ${dirPath}`);
  try {
    await fs.mkdir(dirPath, { recursive: true });
    addLog(deploymentId, `${logPrefix} Successfully ensured directory exists: ${dirPath}`);
  } catch (error: any) {
    const errorMsg = `${logPrefix} Failed to create directory ${dirPath}: ${error.message}`;
    addLog(deploymentId, errorMsg);
    console.error(errorMsg, error); // Log detailed error server-side
    throw new Error(errorMsg);
  }
}

async function uploadDirectoryRecursiveS3(
  localDirPath: string,
  s3BaseKey: string,
  deploymentId: string
) {
  const logPrefix = `[uploadDirectoryRecursiveS3:${deploymentId}]`;
  addLog(deploymentId, `${logPrefix} Starting S3 upload from ${localDirPath} to s3://${OLA_S3_BUCKET_NAME}/${s3BaseKey}`);

  if (!OLA_S3_BUCKET_NAME) {
    const errorMsg = `${logPrefix} Error: OLA_S3_BUCKET_NAME is not configured.`;
    addLog(deploymentId, errorMsg);
    throw new MissingS3ConfigError(errorMsg);
  }
  const currentS3Client = s3Client(); 

  const entries = await fs.readdir(localDirPath, { withFileTypes: true });
  for (const entry of entries) {
    const localEntryPath = path.join(localDirPath, entry.name);
    const cleanEntryName = entry.name.replace(/^\/+|\/+$/g, '');
    const s3ObjectKey = `${s3BaseKey}/${cleanEntryName}`.replace(/^\/+|\/+$/g, '').replace(/\/\//g, '/');

    if (entry.isDirectory()) {
      addLog(deploymentId, `${logPrefix} Recursively uploading directory contents of ${localEntryPath} under S3 key prefix ${s3ObjectKey}`);
      await uploadDirectoryRecursiveS3(localEntryPath, s3ObjectKey, deploymentId);
    } else {
      addLog(deploymentId, `${logPrefix} Uploading file ${localEntryPath} to S3: s3://${OLA_S3_BUCKET_NAME}/${s3ObjectKey}...`);
      const fileBuffer = await fs.readFile(localEntryPath);
      const contentType = mime.lookup(entry.name) || 'application/octet-stream';

      const command = new PutObjectCommand({
        Bucket: OLA_S3_BUCKET_NAME,
        Key: s3ObjectKey,
        Body: fileBuffer,
        ContentType: contentType,
      });
      await currentS3Client.send(command);
      addLog(deploymentId, `${logPrefix} Uploaded ${localEntryPath} to s3://${OLA_S3_BUCKET_NAME}/${s3ObjectKey} successfully.`);
    }
  }
  addLog(deploymentId, `${logPrefix} Finished S3 upload for directory ${localDirPath} to base key ${s3BaseKey}`);
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
  const logPrefix = `[nonAIDetectFramework:${deploymentId}]`;
  addLog(deploymentId, `${logPrefix} Input file for analysis: ${fileNameAnalyzed}.`);
  if (packageJsonContent && fileNameAnalyzed.includes('package.json')) {
    addLog(deploymentId, `${logPrefix} Analyzing package.json...`);
    try {
      const pkg = JSON.parse(packageJsonContent);
      const dependencies = { ...pkg.dependencies, ...pkg.devDependencies };
      const scripts = pkg.scripts || {};

      if (dependencies.next) {
        addLog(deploymentId, `${logPrefix} Detected Next.js.`);
        return { framework: 'nextjs', build_command: scripts.build || 'next build', output_directory: '.next', reasoning: "Next.js dependency found." };
      }
      if (dependencies['@remix-run/dev'] || dependencies.remix) {
        addLog(deploymentId, `${logPrefix} Detected Remix.`);
        return { framework: 'remix', build_command: scripts.build || 'remix build', output_directory: 'public/build', reasoning: "Remix dependency found." };
      }
      if (dependencies['@sveltejs/kit']) {
        addLog(deploymentId, `${logPrefix} Detected SvelteKit.`);
        return { framework: 'sveltekit', build_command: scripts.build || 'npm run build', output_directory: '.svelte-kit/output/client', reasoning: "SvelteKit dependency found." };
      }
      if (dependencies.nuxt) {
        addLog(deploymentId, `${logPrefix} Detected Nuxt.js.`);
        return { framework: 'nuxtjs', build_command: scripts.build || 'npm run build', output_directory: '.output/public', reasoning: "Nuxt.js dependency found." };
      }
      if (dependencies.astro) {
        addLog(deploymentId, `${logPrefix} Detected Astro.`);
        return { framework: 'astro', build_command: scripts.build || 'npm run build', output_directory: 'dist', reasoning: "Astro dependency found." };
      }
       if (dependencies.vite && (dependencies['@vitejs/plugin-react'] || dependencies['@vitejs/plugin-react-swc'])) {
        addLog(deploymentId, `${logPrefix} Detected Vite with React.`);
        return { framework: 'vite-react', build_command: scripts.build || 'vite build', output_directory: 'dist', reasoning: "Vite with React plugin detected." };
      }
       if (dependencies['react-scripts']) {
        addLog(deploymentId, `${logPrefix} Detected Create React App.`);
        return { framework: 'cra', build_command: scripts.build || 'npm run build', output_directory: 'build', reasoning: "Create React App (react-scripts) dependency found." };
      }
      if (dependencies.react && dependencies['react-dom']) {
        addLog(deploymentId, `${logPrefix} Detected Generic React project (react and react-dom found).`);
        return { framework: 'generic-react', build_command: scripts.build || 'npm run build', output_directory: 'dist', reasoning: "Generic React (react and react-dom) dependencies found." };
      }

      addLog(deploymentId, `${logPrefix} package.json found, but no clear common framework indicators. Assuming static or custom Node.js build.`);
      if (scripts.build) {
        addLog(deploymentId, `${logPrefix} Found 'build' script: ${scripts.build}. Assuming custom build outputting to 'dist'.`);
        return { framework: 'custom-build', build_command: scripts.build, output_directory: 'dist', reasoning: "package.json with a build script, but unrecognized frontend framework. Assuming 'dist' output." };
      }
      addLog(deploymentId, `${logPrefix} No specific framework or standard build script found in package.json. Assuming static.`);
      return { framework: 'static', reasoning: "package.json present but no specific framework indicators or standard build script found." };
    } catch (e: any) {
      addLog(deploymentId, `${logPrefix} Error parsing package.json: ${e.message}. Assuming static.`);
      return { framework: 'static', reasoning: "Failed to parse package.json." };
    }
  } else if (fileNameAnalyzed.includes('index.html')) {
    addLog(deploymentId, `${logPrefix} No package.json prioritized. index.html found. Assuming static.`);
    return { framework: 'static', reasoning: "index.html found, no package.json prioritized." };
  }

  addLog(deploymentId, `${logPrefix} No package.json or index.html found for analysis. Assuming static.`);
  return { framework: 'static', reasoning: "No definitive project files (package.json, index.html) found for analysis." };
}

function extractErrorMessage(error: any): string {
  if (!error) return 'An unknown error occurred (error object was null or undefined).';
  if (error instanceof Error) {
    return error.message || 'Error object had no message property.';
  }
  if (typeof error === 'string') {
    return error;
  }
  try {
    const stringified = JSON.stringify(error);
    // Avoid returning "{}" for empty objects, be more descriptive
    if (stringified === '{}') return 'An empty object was thrown as an error.';
    return stringified;
  } catch (e: any) {
    // Fallback if stringify fails (e.g. circular references not handled by simple JSON.stringify)
    let fallbackMessage = 'Could not stringify error object due to an internal error.';
    if (e && typeof e.message === 'string') {
        fallbackMessage = `Could not stringify error object: ${e.message}`;
    }
    // Attempt to get a basic string representation
    const errorAsString = String(error);
    if (errorAsString !== '[object Object]') {
        fallbackMessage += `. Basic error string: ${errorAsString}`;
    }
    return fallbackMessage;
  }
}

async function performFullDeployment(deploymentId: string, formData: FormData) {
  const logPrefix = `[performFullDeployment:${deploymentId}]`;
  console.log(`${logPrefix} Starting full deployment process.`);
  updateStatus(deploymentId, 'Processing input...');
  addLog(deploymentId, `--- ${logPrefix} Process Started ---`);
  
  let finalProjectName = 'untitled-project';
  let uniqueTempIdDir: string | null = null;
  let projectRootPath = '';

  try {
    addLog(deploymentId, `${logPrefix} [Step 1/7] Validating S3 config and creating temp directories...`);
    updateStatus(deploymentId, 'Validating configuration...');
    if (!OLA_S3_BUCKET_NAME) {
      throw new MissingS3ConfigError('S3 bucket name (OLA_S3_BUCKET_NAME) is not configured.');
    }
    s3Client(); 
    addLog(deploymentId, `${logPrefix} S3 client configuration appears valid.`);
    
    await ensureDirectoryExists(TEMP_UPLOAD_DIR, deploymentId, "TempUploadDirSetup");
    const uniqueIdSuffix = Math.random().toString(36).substring(2, 9);
    uniqueTempIdDir = path.join(TEMP_UPLOAD_DIR, `deploy-${deploymentId.substring(0,8)}-${uniqueIdSuffix}`);
    await ensureDirectoryExists(uniqueTempIdDir, deploymentId, "UniqueTempDirSetup");
    addLog(deploymentId, `${logPrefix} Unique temporary directory: ${uniqueTempIdDir}`);

    const githubUrl = formData.get('githubUrl') as string | null;
    const file = formData.get('zipfile') as File | null;

    if (!file && !githubUrl) {
      throw new Error('No file uploaded and no GitHub URL provided.');
    }
    
    let sourceNameForProject = 'untitled-project';
    let baseExtractionDir = '';

    if (githubUrl) {
      addLog(deploymentId, `${logPrefix} [Step 2/7] Processing GitHub URL: ${githubUrl}`);
      updateStatus(deploymentId, 'Cloning repository...');
      if (!githubUrl.match(/^(https?:\/\/)?(www\.)?github\.com\/[\w-]+\/[\w.-]+(\.git)?$/i)) {
        throw new Error('Invalid GitHub URL format.');
      }
      
      baseExtractionDir = path.join(uniqueTempIdDir, 'cloned_repo');
      await ensureDirectoryExists(baseExtractionDir, deploymentId, "GitCloneDirSetup");
      addLog(deploymentId, `${logPrefix} Attempting to clone ${githubUrl} into ${baseExtractionDir}...`);
      try {
        const cloneOutput = await execAsync(`git clone --depth 1 ${githubUrl} .`, { cwd: baseExtractionDir });
        if (cloneOutput.stdout) addLog(deploymentId, `${logPrefix} Git clone stdout:\n${cloneOutput.stdout}`);
        if (cloneOutput.stderr) addLog(deploymentId, `${logPrefix} Git clone stderr (may not be an error):\n${cloneOutput.stderr}`);
        addLog(deploymentId, `${logPrefix} Repository cloned successfully.`);
        sourceNameForProject = githubUrl;
      } catch (cloneError: any) {
        const errorMsg = extractErrorMessage(cloneError);
        addLog(deploymentId, `${logPrefix} Error cloning repository: ${errorMsg}`);
        if (cloneError.stdout) addLog(deploymentId, `${logPrefix} Git clone stdout (on error):\n${cloneError.stdout}`);
        if (cloneError.stderr) addLog(deploymentId, `${logPrefix} Git clone stderr (on error):\n${cloneError.stderr}`);
        throw new Error(`Failed to clone repository: ${errorMsg}`);
      }
    } else if (file) {
      addLog(deploymentId, `${logPrefix} [Step 2/7] Processing uploaded file: ${file.name}`);
      updateStatus(deploymentId, 'Processing ZIP file...');
      if (file.type !== 'application/zip' && file.type !== 'application/x-zip-compressed') {
        throw new Error('Invalid file type. Please upload a ZIP file.');
      }
      
      const tempZipPath = path.join(uniqueTempIdDir, file.name);
      baseExtractionDir = path.join(uniqueTempIdDir, 'extracted_zip');
      await ensureDirectoryExists(baseExtractionDir, deploymentId, "ZipExtractDirSetup");
      addLog(deploymentId, `${logPrefix} Root extraction path for ZIP: ${baseExtractionDir}`);

      const fileBuffer = Buffer.from(await file.arrayBuffer());
      await fs.writeFile(tempZipPath, fileBuffer);
      addLog(deploymentId, `${logPrefix} Temporary ZIP file saved to: ${tempZipPath}`);
      updateStatus(deploymentId, 'Extracting ZIP file...');

      const zip = await JSZip.loadAsync(fileBuffer);
      const fileNamesInZip: string[] = [];
      addLog(deploymentId, `${logPrefix} Extracting ZIP files to ${baseExtractionDir}...`);
      for (const relativePathInZip in zip.files) {
        fileNamesInZip.push(relativePathInZip);
        const zipEntry = zip.files[relativePathInZip];
        const localDestPath = path.join(baseExtractionDir, relativePathInZip);
        if (zipEntry.dir) {
          await ensureDirectoryExists(localDestPath, deploymentId, "ZipDirCreationInLoop");
        } else {
          const content = await zipEntry.async('nodebuffer');
          await ensureDirectoryExists(path.dirname(localDestPath), deploymentId, "ZipFileDirCreationInLoop");
          await fs.writeFile(localDestPath, content);
        }
      }
      addLog(deploymentId, `${logPrefix} ZIP extraction complete. Files extracted: ${fileNamesInZip.length}`);
      if (fileNamesInZip.length === 0) throw new Error('The uploaded ZIP file is empty or invalid.');
      sourceNameForProject = file.name;
    } else {
      throw new Error("No deployment source (ZIP or Git URL) provided.");
    }

    addLog(deploymentId, `${logPrefix} [Step 3/7] Sanitizing project name from: ${sourceNameForProject}`);
    finalProjectName = sanitizeName(sourceNameForProject) || `web-deploy-${deploymentId.substring(0, 5)}`;
    addLog(deploymentId, `${logPrefix} Using project name: ${finalProjectName}`);
    updateStatus(deploymentId, `Project: ${finalProjectName}. Detecting framework...`);

    addLog(deploymentId, `${logPrefix} [Step 4/7] Determining project root and detecting framework...`);
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
        addLog(deploymentId, `${logPrefix}:findAnalysisFile] Found package.json at ${chosenFile}. Project root set to: ${determinedProjectRoot}`);
        return { filePath: path.join(searchBaseDir, chosenFile), content: await fs.readFile(path.join(searchBaseDir, chosenFile), 'utf-8'), relativePath: chosenFile, projectRoot: determinedProjectRoot };
      }
      if (indexHtmlPaths.length > 0) {
         const chosenFile = indexHtmlPaths[0];
         const determinedProjectRoot = path.join(searchBaseDir, path.dirname(chosenFile));
         addLog(deploymentId, `${logPrefix}:findAnalysisFile] Found index.html at ${chosenFile}. Project root set to: ${determinedProjectRoot}`);
         return { filePath: path.join(searchBaseDir, chosenFile), content: await fs.readFile(path.join(searchBaseDir, chosenFile), 'utf-8'), relativePath: chosenFile, projectRoot: determinedProjectRoot };
      }
      addLog(deploymentId, `${logPrefix}:findAnalysisFile] No package.json or suitable index.html found. Defaulting project root to: ${baseExtractionDir}`);
      return { filePath: null, content: null, relativePath: null, projectRoot: baseExtractionDir };
    };

    const analysisResult = await findAnalysisFile(baseExtractionDir, baseExtractionDir);
    projectRootPath = analysisResult.projectRoot;
    let frameworkDetectionResult: FrameworkDetectionResult;
    if (analysisResult.relativePath && analysisResult.content) {
        addLog(deploymentId, `${logPrefix} Framework detection using file: '${analysisResult.relativePath}'. Effective project root: ${projectRootPath}`);
        frameworkDetectionResult = nonAIDetectFramework(analysisResult.content, analysisResult.relativePath, deploymentId);
    } else {
        addLog(deploymentId, `${logPrefix} No specific analysis file found. Effective project root: ${projectRootPath}. Assuming static.`);
        frameworkDetectionResult = nonAIDetectFramework(null, 'none_found_in_search', deploymentId);
    }
    addLog(deploymentId, `${logPrefix} Detected framework: ${frameworkDetectionResult.framework}. Build command: ${frameworkDetectionResult.build_command || 'N/A'}. Output dir: ${frameworkDetectionResult.output_directory || 'N/A'}`);
    if(frameworkDetectionResult.reasoning) addLog(deploymentId, `${logPrefix} Reasoning: ${frameworkDetectionResult.reasoning}`);

    const needsBuild = frameworkDetectionResult.framework !== 'static' && frameworkDetectionResult.build_command;
    let buildSourcePath = projectRootPath;

    if (needsBuild && frameworkDetectionResult.build_command) {
      addLog(deploymentId, `${logPrefix} [Step 5/7] Project requires build. Starting build process in ${projectRootPath}...`);
      updateStatus(deploymentId, 'Running build process...');
      try {
        addLog(deploymentId, `${logPrefix} Updating Browserslist database in ${projectRootPath}...`);
        updateStatus(deploymentId, 'Updating Browserslist DB...');
        try {
          const updateDbOutput = await execAsync('npx update-browserslist-db@latest --yes', { cwd: projectRootPath });
          if(updateDbOutput.stdout) addLog(deploymentId, `${logPrefix} Browserslist update stdout: ${updateDbOutput.stdout}`);
          if(updateDbOutput.stderr) addLog(deploymentId, `${logPrefix} Browserslist update stderr: ${updateDbOutput.stderr}`);
        } catch (updateDbError: any) {
          addLog(deploymentId, `${logPrefix} Warning: Failed to update Browserslist database: ${extractErrorMessage(updateDbError)}. Build will proceed.`);
        }
        
        addLog(deploymentId, `${logPrefix} Running 'npm install --legacy-peer-deps --prefer-offline --no-audit --progress=false' in ${projectRootPath}...`);
        updateStatus(deploymentId, 'Installing dependencies (npm install)...');
        const installOutput = await execAsync('npm install --legacy-peer-deps --prefer-offline --no-audit --progress=false', { cwd: projectRootPath });
        if(installOutput.stdout) addLog(deploymentId, `${logPrefix} npm install stdout: ${installOutput.stdout}`);
        if(installOutput.stderr) addLog(deploymentId, `${logPrefix} npm install stderr: ${installOutput.stderr}`);

        let buildCommandToExecute = frameworkDetectionResult.build_command;
        const buildEnv = { ...process.env };
        const publicUrlForAssets = `/sites/${finalProjectName}`;
        
        if (['cra', 'generic-react', 'vite-react'].includes(frameworkDetectionResult.framework)) {
            buildEnv.PUBLIC_URL = publicUrlForAssets;
            if (frameworkDetectionResult.framework === 'vite-react' && !buildCommandToExecute.includes('--base')) {
                const viteBasePath = publicUrlForAssets.endsWith('/') ? publicUrlForAssets : `${publicUrlForAssets}/`;
                buildCommandToExecute = `${buildCommandToExecute.replace(/vite build/, `vite build --base=${viteBasePath}`)}`; 
                addLog(deploymentId, `${logPrefix} Adjusted Vite build command: '${buildCommandToExecute}'`);
            } else {
                addLog(deploymentId, `${logPrefix} Setting PUBLIC_URL=${publicUrlForAssets} for build.`);
            }
        }
        
        addLog(deploymentId, `${logPrefix} Executing build command: '${buildCommandToExecute}' in ${projectRootPath} with env: ${JSON.stringify(buildEnv.PUBLIC_URL ? { PUBLIC_URL: buildEnv.PUBLIC_URL } : {})}`);
        updateStatus(deploymentId, `Building project (${buildCommandToExecute})...`);
        const buildOutput = await execAsync(buildCommandToExecute, { cwd: projectRootPath, env: buildEnv });
        if(buildOutput.stdout) addLog(deploymentId, `${logPrefix} Build command stdout: ${buildOutput.stdout}`);
        if(buildOutput.stderr) addLog(deploymentId, `${logPrefix} Build command stderr: ${buildOutput.stderr}`);

        const detectedOutputDirName = frameworkDetectionResult.output_directory;
        let foundBuildOutputDir = '';
        if (detectedOutputDirName) {
            const potentialPath = path.join(projectRootPath, detectedOutputDirName);
            try {
                await fs.access(potentialPath);
                if ((await fs.stat(potentialPath)).isDirectory()) {
                    foundBuildOutputDir = potentialPath;
                    addLog(deploymentId, `${logPrefix} Build output successfully found at: ${foundBuildOutputDir}`);
                }
            } catch { /* not found */ }
        }
        if (!foundBuildOutputDir) {
          const commonOutputDirs = ['dist', 'build', 'out', '.next', 'public', '.output/public', '.svelte-kit/output/client'];
          addLog(deploymentId, `${logPrefix} Primary build output directory '${detectedOutputDirName || 'N/A'}' not confirmed. Fallback searching: ${commonOutputDirs.join(', ')} within ${projectRootPath}`);
          for (const dir of commonOutputDirs) {
            if (detectedOutputDirName === dir && !foundBuildOutputDir) continue; 
            const potentialPath = path.join(projectRootPath, dir);
            try {
              await fs.access(potentialPath);
               if ((await fs.stat(potentialPath)).isDirectory()) {
                  foundBuildOutputDir = potentialPath;
                  addLog(deploymentId, `${logPrefix} Found build output directory (fallback search) at: ${foundBuildOutputDir}`);
                  break;
              }
            } catch { /* Directory does not exist */ }
          }
        }
        if (!foundBuildOutputDir) {
          addLog(deploymentId, `${logPrefix} Error: Build output directory not found in ${projectRootPath} after build. Expected: '${detectedOutputDirName || 'various defaults'}'. Uploading from project root as fallback.`);
        } else {
            buildSourcePath = foundBuildOutputDir;
        }
      } catch (buildError: any) {
        const errorMsg = extractErrorMessage(buildError);
        addLog(deploymentId, `${logPrefix} Build process failed: ${errorMsg}`);
        if (buildError.stdout) addLog(deploymentId, `${logPrefix} Build stdout (on error):\n${buildError.stdout}`);
        if (buildError.stderr) addLog(deploymentId, `${logPrefix} Build stderr (on error):\n${buildError.stderr}`);
        throw buildError;
      }
    } else {
      addLog(deploymentId, `${logPrefix} [Step 5/7] Static site or no build command. Preparing for direct upload from ${projectRootPath}.`);
      updateStatus(deploymentId, 'Preparing for static upload...');
      if (githubUrl && frameworkDetectionResult.framework === 'static') {
        try {
          const staticDirContents = await fs.readdir(buildSourcePath);
          addLog(deploymentId, `${logPrefix} Contents of static site source directory '${buildSourcePath}' for upload: ${staticDirContents.join(', ')}`);
        } catch (readdirError: any) {
          addLog(deploymentId, `${logPrefix} Warning: Could not list contents of static site source directory '${buildSourcePath}': ${readdirError.message}`);
        }
      }
    }
    
    addLog(deploymentId, `${logPrefix} [Step 6/7] Uploading files from ${buildSourcePath} to S3...`);
    updateStatus(deploymentId, 'Uploading files to S3...');
    const s3ProjectBaseKey = `sites/${finalProjectName}`;
    await uploadDirectoryRecursiveS3(buildSourcePath, s3ProjectBaseKey, deploymentId);
    addLog(deploymentId, `${logPrefix} Files uploaded successfully to S3.`);

    const deployedUrl = `/sites/${finalProjectName}/`; 
    addLog(deploymentId, `${logPrefix} [Step 7/7] Deployment successful! Site should be accessible at: ${deployedUrl}`);
    updateStatus(deploymentId, 'Deployment successful!');
    
    const finalResult: FullDeploymentResultForStore = {
      success: true,
      message: 'Project deployed successfully!',
      projectName: finalProjectName,
      deployedUrl,
    };
    setDeploymentComplete(deploymentId, finalResult);
    console.log(`${logPrefix} SUCCESS. Project: ${finalProjectName}. URL: ${deployedUrl}`);

  } catch (error: any) {
    const errorMessage = extractErrorMessage(error);
    const errorName = error instanceof Error ? error.name : "UnknownError";
    console.error(`${logPrefix} CRITICAL FAILURE. Project: ${finalProjectName}. Error (${errorName}): ${errorMessage}`, error.stack || error);
    
    addLog(deploymentId, `\n--- ${logPrefix} DEPLOYMENT FAILED ---`);
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
    setDeploymentComplete(deploymentId, finalErrorResult);
    
  } finally {
    const logFinallyPrefix = `${logPrefix}:Finally]`;
    addLog(deploymentId, `${logFinallyPrefix} Process reached 'finally' block.`);
    if (uniqueTempIdDir && uniqueTempIdDir.startsWith(TEMP_UPLOAD_DIR) && uniqueTempIdDir !== TEMP_UPLOAD_DIR) {
      try {
        addLog(deploymentId, `${logFinallyPrefix} Attempting to delete temporary directory: ${uniqueTempIdDir}`);
        await fs.rm(uniqueTempIdDir, { recursive: true, force: true });
        addLog(deploymentId, `${logFinallyPrefix} Successfully deleted temporary directory: ${uniqueTempIdDir}`);
      } catch (cleanupError: any) {
        const cleanupMessage = `${logFinallyPrefix} Error during cleanup of ${uniqueTempIdDir}: ${extractErrorMessage(cleanupError)}`;
        addLog(deploymentId, cleanupMessage);
        console.error(cleanupMessage, cleanupError.stack);
      }
    } else {
       addLog(deploymentId, `${logFinallyPrefix} Skipped deletion of temp directory (path issue or not set): ${uniqueTempIdDir || 'Not Set'}`);
    }

    const finalState = deploymentStates.get(deploymentId);
    if (finalState && !finalState.isDone) {
        const fallbackMessage = "Deployment process concluded with an unexpected state.";
        console.warn(`${logFinallyPrefix} State was not marked as done, forcing it now.`);
        addLog(deploymentId, `${logFinallyPrefix} Forcing deployment completion state due to unexpected termination.`);
        setDeploymentComplete(deploymentId, {
            success: false,
            message: finalState.error || fallbackMessage,
            error: finalState.error || fallbackMessage,
            projectName: finalState.projectName || finalProjectName,
        });
    }
    addLog(deploymentId, `--- ${logPrefix} Process Finished ---`);
    const finalIsDoneState = deploymentStates.get(deploymentId)?.isDone;
    console.log(`${logFinallyPrefix} Final isDone state: ${finalIsDoneState}`);
  }
}

export async function deployProject(formData: FormData): Promise<InitialDeploymentResponse> {
  const actionLogPrefix = "[deployProject:Action]";
  let deploymentId: string = ''; 
  console.log(`${actionLogPrefix} Entered function.`);

  try {
    console.log(`${actionLogPrefix} Entered TRY block.`);
    deploymentId = `dep-${Date.now()}-${Math.random().toString(36).substring(2, 11)}`;
    console.log(`${actionLogPrefix} Generated Deployment ID: ${deploymentId}`);
    
    initializeDeployment(deploymentId);
    addLog(deploymentId, `${actionLogPrefix} Deployment state initialized for ID: ${deploymentId}`);
    updateStatus(deploymentId, 'Deployment process initiated...');

    performFullDeployment(deploymentId, formData)
      .then(() => {
        console.log(`${actionLogPrefix} Background task for ${deploymentId} completed its main execution path.`);
      })
      .catch((err) => {
        const errorMessage = extractErrorMessage(err);
        console.error(`${actionLogPrefix} UNHANDLED CRITICAL error from performFullDeployment PROMISE for ${deploymentId}:`, errorMessage, err.stack, err);
        
        const currentState = deploymentStates.get(deploymentId);
        if (currentState && !currentState.isDone) {
            addLog(deploymentId, `${actionLogPrefix} CRITICAL UNHANDLED ERROR in background task promise: ${errorMessage}`);
            setDeploymentComplete(deploymentId, { 
              success: false,
              message: `A critical unhandled error occurred in the deployment background process: ${errorMessage}`,
              error: errorMessage,
              projectName: currentState.projectName || 'unknown-project',
            });
        }
      });

    const response: InitialDeploymentResponse = {
      success: true,
      deploymentId: deploymentId,
      message: 'Deployment process initiated. Streaming updates...'
    };
    console.log(`${actionLogPrefix} Successfully prepared to return:`, JSON.stringify(response));
    return response;

  } catch (initialError: any) {
    const errorMsg = extractErrorMessage(initialError);
    const errorName = initialError instanceof Error ? initialError.name : "UnknownInitialError";
    console.error(`${actionLogPrefix} CRITICAL error during deployProject INITIATION: Name: ${errorName}, Msg: ${errorMsg}`, initialError.stack, initialError);
    
    if (deploymentId) { 
        const currentState = deploymentStates.get(deploymentId);
        if (currentState && !currentState.isDone) {
            addLog(deploymentId, `${actionLogPrefix} Critical initiation error: ${errorMsg}`);
            setDeploymentComplete(deploymentId, {
                success: false,
                message: `Critical error initializing deployment: ${errorMsg}`,
                error: errorMsg,
                projectName: 'unknown-project-init-fail',
            });
        } else if (!currentState && deploymentId) {
            console.error(`${actionLogPrefix} Deployment state for ${deploymentId} was not found after an initiation error. Attempting to create a failed state.`);
            try {
                initializeDeployment(deploymentId); 
                setDeploymentComplete(deploymentId, {
                    success: false,
                    message: `Critical error initializing deployment (state store issue): ${errorMsg}`,
                    error: errorMsg,
                    projectName: 'unknown-project-init-store-fail',
                });
            } catch (storeInitError: any) {
                console.error(`${actionLogPrefix} Failed to initialize/setComplete for deploymentId ${deploymentId} in catch block: ${extractErrorMessage(storeInitError)}`);
            }
        }
    }

    const errorResponse: InitialDeploymentResponse = {
      success: false,
      deploymentId: deploymentId || undefined, 
      message: `Failed to initiate deployment: ${errorMsg}`,
    };
    console.log(`${actionLogPrefix} Error, prepared to return:`, JSON.stringify(errorResponse));
    return errorResponse;
  }
}
    

    