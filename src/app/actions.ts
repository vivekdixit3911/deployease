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

// This is the actual result of the deployment, sent via SSE or stored
interface FullDeploymentResultForStore {
  success: boolean;
  message: string;
  projectName?: string;
  deployedUrl?: string;
  error?: string; 
}


async function ensureDirectoryExists(dirPath: string, deploymentId: string) {
  addLog(deploymentId, `Ensuring directory exists: ${dirPath}`);
  try {
    await fs.mkdir(dirPath, { recursive: true });
    addLog(deploymentId, `Successfully ensured directory exists: ${dirPath}`);
  } catch (error: any) {
    addLog(deploymentId, `Failed to create directory ${dirPath}: ${error.message}`);
    console.error(`[${deploymentId}] ensureDirectoryExists failed for ${dirPath}:`, error);
    throw new Error(`Failed to create required directory ${dirPath}: ${error.message}`);
  }
}

async function uploadDirectoryRecursiveS3(
  localDirPath: string,
  s3BaseKey: string,
  deploymentId: string
) {
  addLog(deploymentId, `Starting S3 upload from ${localDirPath} to S3 base key s3://${OLA_S3_BUCKET_NAME}/${s3BaseKey}`);
  if (!OLA_S3_BUCKET_NAME) {
    addLog(deploymentId, 'Error: OLA_S3_BUCKET_NAME is not configured for S3 upload.');
    throw new MissingS3ConfigError('OLA_S3_BUCKET_NAME is not configured for S3 upload.');
  }
  const currentS3Client = s3Client();

  const entries = await fs.readdir(localDirPath, { withFileTypes: true });
  for (const entry of entries) {
    const localEntryPath = path.join(localDirPath, entry.name);
    const cleanEntryName = entry.name.replace(/^\/+|\/+$/g, '');
    // Ensure s3ObjectKey doesn't start or end with / and no double slashes
    const s3ObjectKey = `${s3BaseKey}/${cleanEntryName}`.replace(/^\/+|\/+$/g, '').replace(/\/\//g, '/');


    if (entry.isDirectory()) {
      addLog(deploymentId, `Recursively uploading directory contents of ${localEntryPath} under S3 key prefix ${s3ObjectKey}`);
      await uploadDirectoryRecursiveS3(localEntryPath, s3ObjectKey, deploymentId);
    } else {
      addLog(deploymentId, `Uploading file ${localEntryPath} to S3: s3://${OLA_S3_BUCKET_NAME}/${s3ObjectKey}...`);
      const fileBuffer = await fs.readFile(localEntryPath);
      const contentType = mime.lookup(entry.name) || 'application/octet-stream';

      const command = new PutObjectCommand({
        Bucket: OLA_S3_BUCKET_NAME,
        Key: s3ObjectKey,
        Body: fileBuffer,
        ContentType: contentType,
      });
      await currentS3Client.send(command);
      addLog(deploymentId, `Uploaded ${localEntryPath} to s3://${OLA_S3_BUCKET_NAME}/${s3ObjectKey} successfully.`);
    }
  }
  addLog(deploymentId, `Finished S3 upload for directory ${localDirPath} to base key ${s3BaseKey}`);
}

const sanitizeName = (name: string | undefined | null): string => {
  if (!name) return 'untitled-project';
  return name
    .trim()
    .replace(/\.zip$/i, '') // Remove .zip extension
    .replace(/\.git$/i, '') // Remove .git extension
    .replace(/\/$/, '')     // Remove trailing slash
    .split('/')
    .pop() || 'untitled-project' // Get last part after slashes (repo name or file name part)
    .replace(/\s+/g, '-') // Replace spaces with hyphens
    .replace(/[^a-zA-Z0-9-]/g, '') // Remove non-alphanumeric characters except hyphens
    .replace(/-+/g, '-') // Replace multiple hyphens with a single one
    .replace(/^-+|-+$/g, '') // Remove leading/trailing hyphens
    .toLowerCase() || 'untitled-project'; // Convert to lowercase, fallback if empty
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
        return { framework: 'sveltekit', build_command: scripts.build || 'npm run build', output_directory: '.svelte-kit/output/client', reasoning: "SvelteKit dependency found." }; // Vite build is common
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
        // Default build for generic React might not always be 'npm run build', could be webpack, parcel etc.
        // but 'npm run build' is a common convention.
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


async function performFullDeployment(deploymentId: string, formData: FormData) {
  console.log(`[performFullDeployment:${deploymentId}] Starting full deployment process.`);
  updateStatus(deploymentId, 'Processing input...');
  let tempZipPath = '';
  let baseExtractionDir = ''; // This will be the root of the extracted/cloned files
  let projectRootPath = ''; // This might be a subdirectory of baseExtractionDir if package.json is nested
  let finalProjectName = 'untitled-project';
  let uniqueTempIdDir: string | null = null; // The unique top-level temp dir for this deployment

  try {
    addLog(deploymentId, 'Validating S3 configuration...');
    if (!OLA_S3_BUCKET_NAME) {
        addLog(deploymentId, 'Error: S3 bucket name (OLA_S3_BUCKET_NAME) is not configured in environment variables.');
        throw new MissingS3ConfigError('S3 bucket name (OLA_S3_BUCKET_NAME) is not configured.');
    }
    s3Client(); 
    addLog(deploymentId, 'S3 client successfully initialized or retrieved, and OLA_S3_BUCKET_NAME is present.');
    
    await ensureDirectoryExists(TEMP_UPLOAD_DIR, deploymentId);
    // Use a more descriptive unique ID for the temp directory
    const uniqueIdSuffix = Math.random().toString(36).substring(2, 9);
    uniqueTempIdDir = path.join(TEMP_UPLOAD_DIR, `deploy-${deploymentId.substring(0,8)}-${uniqueIdSuffix}`);
    await ensureDirectoryExists(uniqueTempIdDir, deploymentId);
    addLog(deploymentId, `Unique temporary directory for this deployment: ${uniqueTempIdDir}`);

    const githubUrl = formData.get('githubUrl') as string | null;
    const file = formData.get('zipfile') as File | null;

    if (!file && !githubUrl) {
      addLog(deploymentId, 'Error: No file uploaded and no GitHub URL provided.');
      throw new Error('No file uploaded or GitHub URL provided.');
    }
    
    let sourceNameForProject = 'untitled-project'; // Used to derive project name
    updateStatus(deploymentId, githubUrl ? 'Cloning repository...' : 'Processing ZIP file...');

    if (githubUrl) {
      addLog(deploymentId, `Processing GitHub URL: ${githubUrl}`);
      if (!githubUrl.match(/^(https?:\/\/)?(www\.)?github\.com\/[\w-]+\/[\w.-]+(\.git)?$/i)) {
        addLog(deploymentId, `Error: Invalid GitHub URL format: ${githubUrl}.`);
        throw new Error('Invalid GitHub URL format.');
      }
      
      baseExtractionDir = path.join(uniqueTempIdDir, 'cloned_repo'); // Clone into this specific subfolder
      await ensureDirectoryExists(baseExtractionDir, deploymentId);
      addLog(deploymentId, `Attempting to clone repository from ${githubUrl} into ${baseExtractionDir}...`);
      try {
        const cloneOutput = await execAsync(`git clone --depth 1 ${githubUrl} .`, { cwd: baseExtractionDir });
        addLog(deploymentId, `Git clone stdout:\n${cloneOutput.stdout || 'N/A'}`);
        if (cloneOutput.stderr) addLog(deploymentId, `Git clone stderr:\n${cloneOutput.stderr}`);
        addLog(deploymentId, `Repository cloned successfully into ${baseExtractionDir}.`);
        // projectRootPath will be determined later by findAnalysisFile
        sourceNameForProject = githubUrl;
      } catch (cloneError: any) {
        addLog(deploymentId, `Error cloning repository: ${cloneError.message}`);
        if (cloneError.stdout) addLog(deploymentId, `Git clone stdout (on error):\n${cloneError.stdout}`);
        if (cloneError.stderr) addLog(deploymentId, `Git clone stderr (on error):\n${cloneError.stderr}`);
        throw new Error(`Failed to clone repository: ${cloneError.message}`);
      }
    } else if (file) {
      addLog(deploymentId, `Processing uploaded file: ${file.name}`);
      if (file.type !== 'application/zip' && file.type !== 'application/x-zip-compressed') {
        addLog(deploymentId, `Error: Invalid file type received: ${file.type}. Please upload a ZIP file.`);
        throw new Error('Invalid file type. Please upload a ZIP file.');
      }
      
      tempZipPath = path.join(uniqueTempIdDir, file.name); // Save zip in top-level temp dir
      baseExtractionDir = path.join(uniqueTempIdDir, 'extracted_zip'); // Extract into this specific subfolder
      await ensureDirectoryExists(baseExtractionDir, deploymentId);
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
          await ensureDirectoryExists(localDestPath, deploymentId);
        } else {
          const content = await zipEntry.async('nodebuffer');
          // Ensure parent directory of the file exists before writing
          await ensureDirectoryExists(path.dirname(localDestPath), deploymentId);
          await fs.writeFile(localDestPath, content);
        }
      }
      addLog(deploymentId, `ZIP extraction to ${baseExtractionDir} complete. Files extracted: ${fileNamesInZip.length}`);

      if (fileNamesInZip.length === 0) {
        addLog(deploymentId, 'The uploaded ZIP file is empty or invalid.');
        throw new Error('The uploaded ZIP file is empty or invalid.');
      }
      sourceNameForProject = file.name;
    } else {
      // This case should have been caught earlier, but as a safeguard:
      addLog(deploymentId, 'Error: No file or GitHub URL provided for deployment source.');
      throw new Error("No deployment source (ZIP or Git URL) provided.");
    }

    // Determine Project Name
    addLog(deploymentId, `Deriving project name from source: ${sourceNameForProject}`);
    const sanitizedProjectName = sanitizeName(sourceNameForProject);
    finalProjectName = sanitizedProjectName || `web-deploy-${deploymentId.substring(0, 5)}`;
    addLog(deploymentId, `Using project name: ${finalProjectName}`);
    updateStatus(deploymentId, `Project: ${finalProjectName}. Detecting framework...`);

    // Framework Detection and Project Root Determination
    let analysisFileRelativePath: string | null = null;
    let analysisFileContent: string | null = null;
    let frameworkDetectionResult: FrameworkDetectionResult;

    // Finds package.json or index.html to determine the actual project root
    // within the baseExtractionDir.
    const findAnalysisFile = async (currentSearchPath: string, searchBaseDir: string): Promise<{filePath: string | null, content: string | null, relativePath: string | null, projectRoot: string}> => {
      const packageJsonPaths: string[] = [];
      const indexHtmlPaths: string[] = [];

      // Recursive search function
      const findFilesRecursive = async (dir: string) => {
        const entries = await fs.readdir(dir, { withFileTypes: true });
        for (const entry of entries) {
          const fullPath = path.join(dir, entry.name);
          // Get path relative to the initial searchBaseDir (e.g. 'cloned_repo' or 'extracted_zip')
          const relativeToSearchBase = path.relative(searchBaseDir, fullPath); 
          if (entry.isDirectory()) {
            // Skip common large/irrelevant directories
            if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
            await findFilesRecursive(fullPath);
          } else if (entry.name.toLowerCase() === 'package.json') {
            packageJsonPaths.push(relativeToSearchBase);
          } else if (entry.name.toLowerCase() === 'index.html') {
            // Heuristic to avoid picking index.html from build output folders
             if (!relativeToSearchBase.includes('/build/') &&
                !relativeToSearchBase.includes('/dist/') &&
                !relativeToSearchBase.includes('/.next/') &&
                !relativeToSearchBase.includes('/.output/') &&
                !relativeToSearchBase.includes('/.svelte-kit/') &&
                !relativeToSearchBase.includes('/out/') &&
                !relativeToSearchBase.includes('/node_modules/')) { // also skip node_modules
                indexHtmlPaths.push(relativeToSearchBase);
            }
          }
        }
      };
      await findFilesRecursive(currentSearchPath); // Start search from baseExtractionDir

      // Prioritize package.json found at the shallowest depth
      packageJsonPaths.sort((a, b) => a.split(path.sep).length - b.split(path.sep).length);
      // Prioritize index.html found at the shallowest depth (if no package.json)
      indexHtmlPaths.sort((a, b) => a.split(path.sep).length - b.split(path.sep).length);

      if (packageJsonPaths.length > 0) {
        const chosenFile = packageJsonPaths[0]; // Relative path from searchBaseDir
        const determinedProjectRoot = path.join(searchBaseDir, path.dirname(chosenFile));
        addLog(deploymentId, `[findAnalysisFile] Found package.json at ${chosenFile}. Project root set to: ${determinedProjectRoot}`);
        return { filePath: path.join(searchBaseDir, chosenFile), content: await fs.readFile(path.join(searchBaseDir, chosenFile), 'utf-8'), relativePath: chosenFile, projectRoot: determinedProjectRoot };
      }
      if (indexHtmlPaths.length > 0) {
         const chosenFile = indexHtmlPaths[0]; // Relative path from searchBaseDir
         const determinedProjectRoot = path.join(searchBaseDir, path.dirname(chosenFile));
         addLog(deploymentId, `[findAnalysisFile] Found index.html at ${chosenFile}. Project root set to: ${determinedProjectRoot}`);
         return { filePath: path.join(searchBaseDir, chosenFile), content: await fs.readFile(path.join(searchBaseDir, chosenFile), 'utf-8'), relativePath: chosenFile, projectRoot: determinedProjectRoot };
      }
      // If neither package.json nor a suitable index.html is found,
      // assume the baseExtractionDir itself is the project root.
      // This handles cases like a ZIP file containing just index.html and assets at its root.
      addLog(deploymentId, `[findAnalysisFile] No package.json or suitable index.html found. Defaulting project root to: ${baseExtractionDir}`);
      return { filePath: null, content: null, relativePath: null, projectRoot: baseExtractionDir };
    };

    // baseExtractionDir is where files were cloned/extracted (e.g., .../uniqueTempIdDir/cloned_repo)
    const analysisResult = await findAnalysisFile(baseExtractionDir, baseExtractionDir);
    analysisFileRelativePath = analysisResult.relativePath; // Path relative to baseExtractionDir
    analysisFileContent = analysisResult.content;
    projectRootPath = analysisResult.projectRoot; // This is now the path to build/upload from

    if (analysisFileRelativePath && analysisFileContent) {
        addLog(deploymentId, `Framework detection using file: '${analysisFileRelativePath}' (inside ${baseExtractionDir}). Effective project root: ${projectRootPath}`);
        frameworkDetectionResult = nonAIDetectFramework(analysisFileContent, analysisFileRelativePath, deploymentId);
    } else {
        addLog(deploymentId, `No specific analysis file (package.json/index.html) found to drive framework detection. Effective project root: ${projectRootPath}. Assuming static.`);
        frameworkDetectionResult = nonAIDetectFramework(null, 'none_found_in_search', deploymentId);
    }

    addLog(deploymentId, `Detected framework: ${frameworkDetectionResult.framework}. Build command: ${frameworkDetectionResult.build_command || 'N/A'}. Output dir: ${frameworkDetectionResult.output_directory || 'N/A'}`);
    if(frameworkDetectionResult.reasoning) addLog(deploymentId, `Reasoning: ${frameworkDetectionResult.reasoning}`);

    const needsBuild = frameworkDetectionResult.framework !== 'static' && frameworkDetectionResult.build_command;

    if (needsBuild) {
      updateStatus(deploymentId, `Framework ${frameworkDetectionResult.framework} detected. Preparing build...`);
    } else {
      updateStatus(deploymentId, `Static site or no build command. Preparing for direct upload...`);
    }

    const s3ProjectBaseKey = `sites/${finalProjectName}`;
    addLog(deploymentId, `Target S3 base key: ${s3ProjectBaseKey}`);

    // Build process (if needed)
    if (needsBuild && frameworkDetectionResult.build_command) {
      addLog(deploymentId, `Project requires build. Starting build process in ${projectRootPath}...`);
      updateStatus(deploymentId, 'Running build process...');
      try {
        addLog(deploymentId, `Updating Browserslist database in ${projectRootPath}...`);
        updateStatus(deploymentId, 'Updating Browserslist DB...');
        try {
          const updateDbOutput = await execAsync('npx update-browserslist-db@latest --yes', { cwd: projectRootPath });
          addLog(deploymentId, `Browserslist update stdout: ${updateDbOutput.stdout || '(empty)'}`);
          if (updateDbOutput.stderr) addLog(deploymentId, `Browserslist update stderr: ${updateDbOutput.stderr}`);
        } catch (updateDbError: any) {
          addLog(deploymentId, `Warning: Failed to update Browserslist database: ${updateDbError.message}. Build will proceed.`);
        }
        
        addLog(deploymentId, `Running 'npm install --legacy-peer-deps --prefer-offline --no-audit --progress=false' in ${projectRootPath}...`);
        updateStatus(deploymentId, 'Installing dependencies (npm install)...');
        const installOutput = await execAsync('npm install --legacy-peer-deps --prefer-offline --no-audit --progress=false', { cwd: projectRootPath });
        addLog(deploymentId, `npm install stdout: ${installOutput.stdout || '(empty)'}`);
        if (installOutput.stderr) addLog(deploymentId, `npm install stderr: ${installOutput.stderr}`);

        let buildCommandToExecute = frameworkDetectionResult.build_command;
        const buildEnv = { ...process.env };
        const publicUrlForAssets = `/sites/${finalProjectName}`; // Path for subfolder hosting
        
        if (['cra', 'generic-react'].includes(frameworkDetectionResult.framework)) {
            buildEnv.PUBLIC_URL = publicUrlForAssets;
            addLog(deploymentId, `Setting PUBLIC_URL=${publicUrlForAssets} for build.`);
        } else if (frameworkDetectionResult.framework === 'vite-react') {
            const viteBasePath = publicUrlForAssets.endsWith('/') ? publicUrlForAssets : `${publicUrlForAssets}/`;
            // Ensure we only add --base if not already present
            if (!buildCommandToExecute.includes('--base')) {
                buildCommandToExecute = `${buildCommandToExecute.replace(/vite build/, `vite build --base ${viteBasePath}`)}`;
            }
            addLog(deploymentId, `Adjusted Vite build command: '${buildCommandToExecute}'.`);
        }
        // For other frameworks, PUBLIC_URL might be respected or they might need specific config file changes (out of scope for auto-adjust here)
        
        addLog(deploymentId, `Executing build command: '${buildCommandToExecute}' in ${projectRootPath}`);
        updateStatus(deploymentId, `Building project (${buildCommandToExecute})...`);
        const buildOutput = await execAsync(buildCommandToExecute, { cwd: projectRootPath, env: buildEnv });
        addLog(deploymentId, `Build command stdout: ${buildOutput.stdout || '(empty)'}`);
        if (buildOutput.stderr) addLog(deploymentId, `Build command stderr: ${buildOutput.stderr}`);

        const detectedOutputDirName = frameworkDetectionResult.output_directory; // This is a relative name like 'dist', '.next'
        let buildSourcePath = ''; // This will be the absolute path to the output directory
        if (detectedOutputDirName) {
            const potentialPath = path.join(projectRootPath, detectedOutputDirName);
            try {
                await fs.access(potentialPath); // Check if it exists
                if ((await fs.stat(potentialPath)).isDirectory()) {
                    buildSourcePath = potentialPath;
                    addLog(deploymentId, `Build output successfully found at: ${buildSourcePath}`);
                } else {
                   addLog(deploymentId, `Expected output path ${potentialPath} exists but is not a directory.`);
                }
            } catch {
                addLog(deploymentId, `Expected output directory ${potentialPath} (from ${detectedOutputDirName}) not found or not accessible.`);
            }
        }

        if (!buildSourcePath) {
          // Fallback search if primary detected output dir isn't found
          const commonOutputDirs = ['dist', 'build', 'out', '.next', 'public', '.output/public', '.svelte-kit/output/client'];
          addLog(deploymentId, `Build output directory '${detectedOutputDirName || 'N/A'}' not confirmed. Fallback searching common directories: ${commonOutputDirs.join(', ')} within ${projectRootPath}`);
          for (const dir of commonOutputDirs) {
            // Avoid re-checking if it was already the detected one and failed
            if (detectedOutputDirName === dir && !buildSourcePath) continue; 
            const potentialPath = path.join(projectRootPath, dir);
            try {
              await fs.access(potentialPath);
               if ((await fs.stat(potentialPath)).isDirectory()) {
                  buildSourcePath = potentialPath;
                  addLog(deploymentId, `Found build output directory (fallback search) at: ${buildSourcePath}`);
                  frameworkDetectionResult.output_directory = dir; // Update if found via fallback
                  break;
              }
            } catch { /* Directory does not exist or not accessible */ }
          }
        }

        if (!buildSourcePath) {
          addLog(deploymentId, `Error: Build output directory not found in ${projectRootPath} after build. Expected based on detection: '${detectedOutputDirName || 'N/A'}'. Tried fallbacks.`);
          try {
            const rootContents = await fs.readdir(projectRootPath, {withFileTypes: true});
            addLog(deploymentId, `Contents of ${projectRootPath} post-build: ${rootContents.map(entry => `${entry.name}${entry.isDirectory() ? '/' : ''}`).join(', ')}`);
          } catch(e: any) { addLog(deploymentId, `Could not list contents of ${projectRootPath}: ${e.message}`); }
          throw new Error(`Build output directory not found. Check build scripts and output configuration. Expected relative dir: '${detectedOutputDirName || 'various defaults'}'.`);
        }

        addLog(deploymentId, `Uploading built files from ${buildSourcePath} to S3...`);
        updateStatus(deploymentId, 'Uploading built files to S3...');
        await uploadDirectoryRecursiveS3(buildSourcePath, s3ProjectBaseKey, deploymentId);
        addLog(deploymentId, `Built files uploaded successfully to S3.`);

      } catch (buildError: any) {
        addLog(deploymentId, `Build process failed: ${buildError.message}`);
        if (buildError.stdout) addLog(deploymentId, `Build stdout:\n${buildError.stdout}`);
        if (buildError.stderr) addLog(deploymentId, `Build command stderr:\n${buildError.stderr}`);
        if (buildError.stack) addLog(deploymentId, `Build stack:\n${buildError.stack}`);
        throw buildError;
      }
    } else {
      // Static site or no build needed
      addLog(deploymentId, `Static site or no build required. Uploading files directly from ${projectRootPath} to S3...`);
      updateStatus(deploymentId, 'Uploading static files to S3...');
      await uploadDirectoryRecursiveS3(projectRootPath, s3ProjectBaseKey, deploymentId);
      addLog(deploymentId, `Static files uploaded successfully to S3.`);
    }

    const deployedUrl = `/sites/${finalProjectName}/`; // Ensure trailing slash for consistency with index.html serving
    addLog(deploymentId, `Deployment successful. Site should be accessible at: ${deployedUrl}`);
    updateStatus(deploymentId, 'Deployment successful!');
    
    const finalResult: FullDeploymentResultForStore = {
      success: true,
      message: 'Project deployed successfully!',
      projectName: finalProjectName,
      deployedUrl,
    };
    setDeploymentComplete(deploymentId, finalResult);
    console.log(`[performFullDeployment:${deploymentId}] SUCCESS. Project: ${finalProjectName}. URL: ${deployedUrl}`);

  } catch (error: any) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    const errorName = error instanceof Error ? error.name : "UnknownError";
    console.error(`[performFullDeployment:${deploymentId}] CRITICAL FAILURE. Project: ${finalProjectName}. Error (${errorName}): ${errorMessage}`, error.stack || error);
    
    addLog(deploymentId, `\n--- DEPLOYMENT FAILED ---`);
    addLog(deploymentId, `Error Type: ${errorName}`);
    addLog(deploymentId, `Error Message: ${errorMessage}`);
    if (error instanceof Error && error.stack) {
        addLog(deploymentId, `Stack Trace:\n${error.stack}`);
    }
    
    updateStatus(deploymentId, `Failed: ${errorMessage.substring(0, 100)}...`); // Truncate for status
    const finalErrorResult: FullDeploymentResultForStore = {
        success: false,
        message: `Deployment failed: ${errorMessage}`,
        projectName: finalProjectName, 
        error: errorMessage,
    };
    setDeploymentComplete(deploymentId, finalErrorResult);
    
  } finally {
    addLog(deploymentId, `Deployment process for ${deploymentId} reached 'finally' block.`);
    if (uniqueTempIdDir && uniqueTempIdDir.startsWith(TEMP_UPLOAD_DIR) && uniqueTempIdDir !== TEMP_UPLOAD_DIR) {
      try {
        addLog(deploymentId, `Attempting to delete temporary directory: ${uniqueTempIdDir}`);
        await fs.rm(uniqueTempIdDir, { recursive: true, force: true });
        addLog(deploymentId, `Successfully deleted temporary directory: ${uniqueTempIdDir}`);
      } catch (cleanupError: any) {
        const cleanupMessage = `Error during cleanup of ${uniqueTempIdDir}: ${cleanupError.message}`;
        addLog(deploymentId, cleanupMessage);
        console.error(`[performFullDeployment:${deploymentId}] Cleanup Error for ${uniqueTempIdDir}:`, cleanupError.message, cleanupError.stack);
      }
    } else {
       addLog(deploymentId, `Skipping deletion of temp directory (path issue or not set): ${uniqueTempIdDir || 'Not Set'}`);
    }
    addLog(deploymentId, 'Deployment process and cleanup attempts finished.');
    // Ensure state is marked as done if not already
    const finalState = deploymentStates.get(deploymentId);
    if (finalState && !finalState.isDone) {
        console.warn(`[performFullDeployment:${deploymentId}] State was not marked as done, forcing it now.`);
        setDeploymentComplete(deploymentId, {
            success: finalState.success ?? false,
            message: finalState.error || "Process concluded with an unexpected state.",
            error: finalState.error || "Process concluded with an unexpected state.",
            projectName: finalState.projectName,
            deployedUrl: finalState.deployedUrl,
        });
    }
    console.log(`[performFullDeployment:${deploymentId}] Final state isDone: ${deploymentStates.get(deploymentId)?.isDone}`);
  }
}

export async function deployProject(formData: FormData): Promise<InitialDeploymentResponse> {
  const deploymentId = `dep-${Date.now()}-${Math.random().toString(36).substring(2, 11)}`;
  console.log(`[deployProject:Action] Initiating new deployment with ID: ${deploymentId}`);
  
  initializeDeployment(deploymentId); // Initialize state in the store

  // Perform the actual deployment asynchronously.
  // We don't await this promise here because we want to return the deploymentId to the client ASAP.
  // This effectively runs performFullDeployment in the "background".
  performFullDeployment(deploymentId, formData)
    .then(() => {
      console.log(`[deployProject:Action] Background task for ${deploymentId} completed its execution path.`);
      // Final state setting is handled within performFullDeployment's try/catch/finally
    })
    .catch((err) => {
      // This catch is a safety net for truly unhandled promise rejections from performFullDeployment itself,
      // though errors *within* performFullDeployment should be caught and handled there.
      console.error(`[deployProject:Action] UNHANDLED error from performFullDeployment background task for ${deploymentId}:`, err);
      setDeploymentComplete(deploymentId, { // Ensure store reflects this critical failure
        success: false,
        message: 'A critical unhandled error occurred in the deployment background process.',
        error: err instanceof Error ? err.message : String(err),
      });
    });

  return {
    success: true, // Indicates the initiation was successful
    deploymentId: deploymentId,
    message: 'Deployment process initiated. Streaming updates...'
  };
}

// Helper: Get a unique temporary directory path
function getUniqueTempDir(baseTempDir: string, deploymentId: string): string {
    const uniqueSuffix = Math.random().toString(36).substring(2, 9);
    const dirName = `deploy-${deploymentId.substring(0, 8)}-${uniqueSuffix}`;
    return path.join(baseTempDir, dirName);
}
