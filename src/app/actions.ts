
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
import { fixCodeInFile } from '@/ai/flows/fix-code-flow';
import { db } from '@/lib/firebase'; // Import db
import { doc, setDoc, Timestamp } from 'firebase/firestore'; // Import Firestore functions

const execAsync = promisify(exec);
const MAX_LOG_LINES_TO_CLIENT = 50;

export interface DeploymentResult {
  success: boolean;
  message: string;
  projectName?: string;
  deployedUrl?: string;
  error?: string;
  logs: string[];
  deploymentId?: string; // To use as Firestore document ID
}

interface ParsedError {
  filePath: string;
  errorMessage: string;
  rawErrorLines: string[];
}

function extractErrorMessage(error: any): string {
  const defaultMessage = 'An unknown error occurred during deployment.';
  const maxLength = 250;

  if (!error) return defaultMessage;

  let extractedMessage: string;

  if (error instanceof Error) {
    extractedMessage = error.message || defaultMessage;
  } else if (typeof error === 'string') {
    extractedMessage = error || defaultMessage;
  } else {
    extractedMessage = String(error); // Try to stringify if it's something else
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
  project_type_context: string; // Made non-optional for AI context
}

function nonAIDetectFramework(packageJsonContent: string | null, fileNameAnalyzed: string, logs: string[]): FrameworkDetectionResult {
    const logPrefix = `[nonAIDetectFramework]`;
    logs.push(`${logPrefix} Input file for analysis: ${fileNameAnalyzed}.`);
    
    let project_type_context = 'Unknown project type'; // Default context

    if (packageJsonContent && fileNameAnalyzed.includes('package.json')) {
        logs.push(`${logPrefix} Analyzing package.json...`);
        try {
            const pkg = JSON.parse(packageJsonContent);
            const dependencies = { ...pkg.dependencies, ...pkg.devDependencies };
            const scripts = pkg.scripts || {};
            const isTypeScript = !!(dependencies.typescript || pkg.types || pkg.typings || Object.keys(pkg.devDependencies || {}).includes('typescript'));

            if (dependencies.next) {
                project_type_context = `Next.js ${isTypeScript ? 'TypeScript' : 'JavaScript'} project`;
                logs.push(`${logPrefix} Detected Next.js. Context: ${project_type_context}`);
                return { framework: 'nextjs', build_command: scripts.build || 'npm run build --if-present || next build', output_directory: '.next', reasoning: "Next.js dependency found.", project_type_context };
            }
            if (dependencies['@remix-run/dev'] || dependencies.remix) {
                project_type_context = `Remix ${isTypeScript ? 'TypeScript' : 'JavaScript'} project`;
                logs.push(`${logPrefix} Detected Remix. Context: ${project_type_context}`);
                return { framework: 'remix', build_command: scripts.build || 'npm run build --if-present || remix build', output_directory: 'public/build', reasoning: "Remix dependency found.", project_type_context };
            }
            if (dependencies['react-scripts']) {
                project_type_context = `Create React App ${isTypeScript ? 'TypeScript' : 'JavaScript'} project`;
                logs.push(`${logPrefix} Detected Create React App. Context: ${project_type_context}`);
                return { framework: 'cra', build_command: scripts.build || 'npm run build', output_directory: 'build', reasoning: "Create React App (react-scripts) dependency found.", project_type_context };
            }
            if (dependencies.vite && (dependencies['@vitejs/plugin-react'] || dependencies['@vitejs/plugin-react-swc'])) {
                project_type_context = `Vite React ${isTypeScript ? 'TypeScript' : 'JavaScript'} project`;
                logs.push(`${logPrefix} Detected Vite with React. Context: ${project_type_context}`);
                return { framework: 'vite-react', build_command: scripts.build || 'npm run build --if-present || vite build', output_directory: 'dist', reasoning: "Vite with React plugin detected.", project_type_context };
            }
            if (dependencies.react && dependencies['react-dom']) {
                project_type_context = `Generic React ${isTypeScript ? 'TypeScript' : 'JavaScript'} project`;
                logs.push(`${logPrefix} Detected Generic React project. Context: ${project_type_context}`);
                return { framework: 'generic-react', build_command: scripts.build || 'npm run build', output_directory: 'dist', reasoning: "Generic React (react and react-dom) dependencies found.", project_type_context };
            }

            logs.push(`${logPrefix} package.json found, but no clear common framework indicators. Assuming static or custom Node.js build.`);
            project_type_context = `Custom build project ${isTypeScript ? 'with TypeScript' : ''}`.trim();
            if (scripts.build) {
                logs.push(`${logPrefix} Found 'build' script: ${scripts.build}. Assuming custom build outputting to 'dist'. Context: ${project_type_context}`);
                return { framework: 'custom-build', build_command: scripts.build, output_directory: 'dist', reasoning: "package.json with a build script, but unrecognized frontend framework. Assuming 'dist' output.", project_type_context };
            }
            project_type_context = 'Static project or Node.js backend (from package.json without build script)';
            logs.push(`${logPrefix} No specific framework or standard build script found in package.json. Assuming static. Context: ${project_type_context}`);
            return { framework: 'static', reasoning: "package.json present but no specific framework indicators or standard build script found.", project_type_context };

        } catch (e: any) {
            project_type_context = 'Static project (package.json parse error)';
            logs.push(`${logPrefix} Error parsing package.json: ${extractErrorMessage(e)}. Assuming static. Context: ${project_type_context}`);
            return { framework: 'static', reasoning: `Failed to parse package.json: ${extractErrorMessage(e)}`, project_type_context };
        }
    } else if (fileNameAnalyzed.includes('index.html')) {
        project_type_context = 'Static HTML project';
        logs.push(`${logPrefix} No package.json prioritized. index.html found. Assuming static. Context: ${project_type_context}`);
        return { framework: 'static', reasoning: "index.html found, no package.json prioritized.", project_type_context };
    }

    project_type_context = 'Static project (no indicative files)';
    logs.push(`${logPrefix} No package.json or index.html found for analysis. Assuming static. Context: ${project_type_context}`);
    return { framework: 'static', reasoning: "No definitive project files (package.json, index.html) found for analysis.", project_type_context };
}

function parseBuildErrors(buildOutput: string, projectRoot: string): ParsedError | null {
    const lines = buildOutput.split('\n');
    // Extremely simplified error parser - looks for common patterns like "Error in ./src/some/file.tsx"
    // or "ERROR in [path]" or tsc errors "path(line,col): error TSxxxx:"
    // This is a placeholder and needs to be much more robust for real-world use.
    
    // TypeScript error: e.g. src/components/MyComponent.tsx(10,5): error TS2322: Type 'string' is not assignable to type 'number'.
    const tsErrorRegex = /^(.*?\.[jt]sx?)\((\d+),(\d+)\):\s*error\s*(TS\d+):\s*(.*)$/im;
    // Webpack/general error: e.g. ERROR in ./src/App.js or Error in /path/to/file.js
    const genericErrorRegex = /(?:ERROR in|Error:)\s*([./\w-]+\.[jt]sx?)/i;

    let filePath: string | undefined;
    let errorMessage: string | undefined;
    const rawErrorLines: string[] = [];

    for (const line of lines) {
        if (line.toLowerCase().includes('error')) {
            rawErrorLines.push(line);
        }
        const tsMatch = line.match(tsErrorRegex);
        if (tsMatch) {
            filePath = tsMatch[1];
            errorMessage = `${tsMatch[4]}: ${tsMatch[5]} (at line ${tsMatch[2]}, col ${tsMatch[3]})`;
            break; 
        }
        const genericMatch = line.match(genericErrorRegex);
        if (genericMatch && !filePath) { // Prioritize TS errors if found
            filePath = genericMatch[1];
            // Try to find subsequent lines that form the message
            const errorLineIndex = lines.indexOf(line);
            errorMessage = lines.slice(errorLineIndex, Math.min(errorLineIndex + 3, lines.length)).join('\n');
            break;
        }
    }

    if (filePath && errorMessage) {
        // Normalize filePath to be relative to projectRoot if it's absolute, or ensure it's just the relative path
        let finalFilePath = filePath.startsWith('/') ? path.relative(projectRoot, filePath) : filePath;
        finalFilePath = finalFilePath.replace(/^[\.\/\\]+/, ''); // Clean leading ./ or .\

        return { filePath: finalFilePath, errorMessage, rawErrorLines };
    }
    if(rawErrorLines.length > 0){
        // If we captured error lines but couldn't parse a specific file, return the raw errors
        // This is a fallback so AI has *something* if specific parsing fails
        return { filePath: 'unknown_file_see_raw_errors', errorMessage: 'Could not parse specific file from build output. See raw error lines.', rawErrorLines };
    }

    return null;
}


async function performFullDeployment(
  userId: string, // Added userId
  formData: FormData,
  parentDeploymentId: string 
): Promise<DeploymentResult> {
  const internalLogs: string[] = [];
  const logPrefix = `[performFullDeployment:${parentDeploymentId}]`;
  internalLogs.push(`--- ${logPrefix} Process Started for user: ${userId} ---`);

  let uniqueTempIdDir: string | null = null;
  let finalProjectNameForErrorHandling = 'untitled-project-setup-phase';
  let baseSourcePath = ''; 

  try {
    internalLogs.push(`${logPrefix} [Step 1/8] Validating S3 config and creating temp directories...`);
    s3Client(); 
    if (!OLA_S3_BUCKET_NAME) {
        throw new MissingS3ConfigError('S3 bucket name (OLA_S3_BUCKET_NAME) is not configured.');
    }
    await ensureDirectoryExists(TEMP_UPLOAD_DIR, internalLogs, "TempUploadDirSetup");
    const uniqueIdSuffix = Math.random().toString(36).substring(2, 9);
    uniqueTempIdDir = path.join(TEMP_UPLOAD_DIR, `deploy-${parentDeploymentId.substring(0,10)}-${userId.substring(0,5)}-${uniqueIdSuffix}`);
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
        if (cloneOutput.stdout) internalLogs.push(`${logPrefix} Git clone stdout:\n${cloneOutput.stdout.substring(0, 500)}...`);
        if (cloneOutput.stderr) internalLogs.push(`${logPrefix} Git clone stderr (may not be an error):\n${cloneOutput.stderr.substring(0, 500)}...`);
        internalLogs.push(`${logPrefix} Repository cloned successfully into ${baseSourcePath}.`);
        sourceNameForProject = githubUrl;
      } catch (cloneError: any) {
        const errorMsg = extractErrorMessage(cloneError);
        internalLogs.push(`${logPrefix} Error cloning repository: ${errorMsg}`);
        if (cloneError.stdout) internalLogs.push(`${logPrefix} Git clone stdout (on error):\n${(cloneError.stdout as string).substring(0,500)}...`);
        if (cloneError.stderr) internalLogs.push(`${logPrefix} Git clone stderr (on error):\n${(cloneError.stderr as string).substring(0,500)}...`);
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
      throw new Error('No file or GitHub URL provided.'); 
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
             if (!newRelativePath.includes('/build/') && !newRelativePath.includes('/dist/') && !newRelativePath.includes('/.next/') && !newRelativePath.includes('/out/')) { 
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
    internalLogs.push(`${logPrefix} Detected framework: ${frameworkDetectionResult.framework}. Build cmd: ${frameworkDetectionResult.build_command || 'N/A'}. Output dir: ${frameworkDetectionResult.output_directory || 'N/A'}. Project Context: ${frameworkDetectionResult.project_type_context}`);

    const needsBuild = frameworkDetectionResult.framework !== 'static' && frameworkDetectionResult.build_command;
    let sourcePathForUpload = effectiveProjectRoot; 
    let aiFixAttempted = false;

    if (needsBuild && frameworkDetectionResult.build_command) {
      internalLogs.push(`${logPrefix} [Step 5/8] Project requires build. Starting build process...`);
      
      for (let attempt = 1; attempt <= 2; attempt++) {
        internalLogs.push(`${logPrefix} Build attempt #${attempt}...`);
        
        internalLogs.push(`${logPrefix} Running 'npm install --legacy-peer-deps --prefer-offline --no-audit --progress=false' in ${effectiveProjectRoot}...`);
        try {
          const installOutput = await execAsync('npm install --legacy-peer-deps --prefer-offline --no-audit --progress=false', { cwd: effectiveProjectRoot });
          if(installOutput.stdout) internalLogs.push(`${logPrefix} npm install stdout (attempt ${attempt}):\n${installOutput.stdout.substring(0,1000)}...`);
          if(installOutput.stderr) internalLogs.push(`${logPrefix} npm install stderr (attempt ${attempt}, may not be error):\n${installOutput.stderr.substring(0,1000)}...`);
          internalLogs.push(`${logPrefix} npm install completed (attempt ${attempt}).`);
        } catch (installError: any) {
          const errorMsg = extractErrorMessage(installError);
          internalLogs.push(`${logPrefix} npm install FAILED (attempt ${attempt}): ${errorMsg}`);
          if (installError.stdout) internalLogs.push(`${logPrefix} npm install stdout (on error, attempt ${attempt}):\n${(installError.stdout as string).substring(0,1000)}...`);
          if (installError.stderr) internalLogs.push(`${logPrefix} npm install stderr (on error, attempt ${attempt}):\n${(installError.stderr as string).substring(0,1000)}...`);
          if (attempt === 1 && !aiFixAttempted) { // Only try AI fix on first install failure if no build error triggered AI yet
              internalLogs.push(`${logPrefix} npm install failed. Not attempting AI fix for dependency issues directly. Will proceed to build command if possible, or fail.`);
              // Depending on strictness, could throw here or let build command fail
          }
          // For now, let's let the build command attempt run, it might provide more specific errors for AI
          // throw new Error(`npm install failed on attempt ${attempt}: ${errorMsg}. Check project dependencies and logs.`);
        }
        
        let buildCommandToExecute = frameworkDetectionResult.build_command;
        const buildEnv = { ...process.env, NODE_ENV: 'production' }; // Force production for builds
        const publicUrlForAssets = `/sites/users/${userId}/sites/${finalProjectName}`; 

        if (['cra', 'generic-react', 'vite-react'].includes(frameworkDetectionResult.framework)) {
            buildEnv.PUBLIC_URL = publicUrlForAssets; 
            if (frameworkDetectionResult.framework === 'vite-react') {
              if (!buildCommandToExecute.includes('--base')) {
                const viteBasePath = publicUrlForAssets.endsWith('/') ? publicUrlForAssets : `${publicUrlForAssets}/`;
                buildCommandToExecute = `${buildCommandToExecute.replace(/vite build/, `vite build --base=${viteBasePath}`)}`;
                internalLogs.push(`${logPrefix} Adjusted Vite build command for base path: '${buildCommandToExecute}'`);
              }
            }
            internalLogs.push(`${logPrefix} Setting PUBLIC_URL or equivalent for build: ${publicUrlForAssets}`);
        } else if (frameworkDetectionResult.framework === 'nextjs') {
             // For Next.js, BASE_PATH might be needed if deploying to a subpath and not using assetPrefix
             // However, next build is usually smart enough. If issues arise, consider setting BASE_PATH.
             // buildEnv.BASE_PATH = publicUrlForAssets; // Example
             // internalLogs.push(`${logPrefix} Setting BASE_PATH for Next.js build: ${publicUrlForAssets}`);
        }
        
        internalLogs.push(`${logPrefix} Executing build command: '${buildCommandToExecute}' in ${effectiveProjectRoot}`);
        try {
          const buildOutput = await execAsync(buildCommandToExecute, { cwd: effectiveProjectRoot, env: buildEnv });
          if(buildOutput.stdout) internalLogs.push(`${logPrefix} Build command stdout (attempt ${attempt}):\n${buildOutput.stdout.substring(0,2000)}...`);
          if(buildOutput.stderr) internalLogs.push(`${logPrefix} Build command stderr (attempt ${attempt}, may not be error):\n${buildOutput.stderr.substring(0,1000)}...`);
          internalLogs.push(`${logPrefix} Build command SUCCEEDED on attempt ${attempt}.`);
          
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
            const commonOutputDirs = ['dist', 'build', 'out', '.next', 'public', '.output/public', '.svelte-kit/output/client', 'public/build', 'www'];
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
            internalLogs.push(`${logPrefix} Build output directory not found. Trying effective project root.`);
            // If build succeeded but output dir is not standard, it might be an in-place build or static site generator that modifies root.
            // For many SSGs (like Astro with `output: 'static'`), the output is in `dist` but for some (like basic Jekyll) it might be `_site` or root.
            // If no dir found, assume it's in effectiveProjectRoot for now. This is risky.
            // A better approach would be to fail here if an output_directory was expected but not found.
            // For now, if build_command was run, and output_directory was specified but not found, it's an error.
             if(frameworkDetectionResult.output_directory) {
                throw new Error(`Build output directory '${frameworkDetectionResult.output_directory}' was specified but not found in ${effectiveProjectRoot} after build. Check build logs for actual output location.`);
             } else {
                // If no output_directory was specified, but build ran, maybe it's fine.
                internalLogs.push(`${logPrefix} Build ran, but no specific output_directory was set by detection. Assuming output is in effective project root or handled by build process. Uploading from: ${effectiveProjectRoot}`);
                foundBuildOutputDir = effectiveProjectRoot; // Or handle more gracefully
             }
          }
          sourcePathForUpload = foundBuildOutputDir;
          internalLogs.push(`${logPrefix} [Step 6/8] Build successful. Source for S3 upload: ${sourcePathForUpload}`);
          break; // Exit loop on successful build

        } catch (buildError: any) {
          const errorMsg = extractErrorMessage(buildError);
          const fullBuildOutput = `${buildError.stdout || ''}\n${buildError.stderr || ''}`;
          internalLogs.push(`${logPrefix} Build command FAILED on attempt ${attempt}: ${errorMsg}`);
          if (buildError.stdout) internalLogs.push(`${logPrefix} Build command stdout (on error, attempt ${attempt}):\n${(buildError.stdout as string).substring(0,2000)}...`);
          if (buildError.stderr) internalLogs.push(`${logPrefix} Build command stderr (on error, attempt ${attempt}):\n${(buildError.stderr as string).substring(0,2000)}...`);

          if (attempt === 1 && !aiFixAttempted) {
            internalLogs.push(`${logPrefix} Attempting AI fix for build error...`);
            aiFixAttempted = true; // Ensure AI fix is only attempted once
            const parsedError = parseBuildErrors(fullBuildOutput, effectiveProjectRoot);

            if (parsedError && parsedError.filePath !== 'unknown_file_see_raw_errors') {
              const fullErroredFilePath = path.join(effectiveProjectRoot, parsedError.filePath);
              internalLogs.push(`${logPrefix} AI Target: Error seems to be in file '${parsedError.filePath}'. Full path: ${fullErroredFilePath}`);
              try {
                const originalFileContent = await fs.readFile(fullErroredFilePath, 'utf-8');
                internalLogs.push(`${logPrefix} Invoking AI to fix code in '${parsedError.filePath}'. Error message context: ${parsedError.errorMessage.substring(0, 200)}...`);
                
                const aiFixResult = await fixCodeInFile({
                  filePath: parsedError.filePath,
                  fileContent: originalFileContent,
                  errorMessage: parsedError.errorMessage + "\nFull build output (relevant parts):\n" + parsedError.rawErrorLines.join("\n").substring(0,1500),
                  projectContext: frameworkDetectionResult.project_type_context,
                });

                if (aiFixResult.fixApplied && aiFixResult.fixedFileContent !== originalFileContent && (aiFixResult.confidence || 0) > 0.5) {
                  internalLogs.push(`${logPrefix} AI suggested a fix for '${parsedError.filePath}' with confidence ${aiFixResult.confidence}. Applying and retrying build.`);
                  internalLogs.push(`${logPrefix} AI Reasoning: ${aiFixResult.reasoning}`);
                  await fs.writeFile(fullErroredFilePath, aiFixResult.fixedFileContent);
                  internalLogs.push(`${logPrefix} File '${parsedError.filePath}' updated with AI fix. Continuing to next build attempt...`);
                  continue; // Retry the loop (npm install and build)
                } else {
                  internalLogs.push(`${logPrefix} AI did not apply a confident fix (fixApplied: ${aiFixResult.fixApplied}, confidence: ${aiFixResult.confidence || 0}). Reasoning: ${aiFixResult.reasoning}. Failing build.`);
                  throw new Error(`Project build failed: ${errorMsg}. AI fix was not applied or not confident.`);
                }
              } catch (fileOrAiError: any) {
                internalLogs.push(`${logPrefix} Error during AI fix attempt for '${parsedError.filePath}': ${extractErrorMessage(fileOrAiError)}. Failing build.`);
                throw new Error(`Project build failed: ${errorMsg}. Additional error during AI fix attempt: ${extractErrorMessage(fileOrAiError)}`);
              }
            } else {
              internalLogs.push(`${logPrefix} Could not parse a specific file from build errors or AI fix already attempted. Raw errors: ${parsedError?.rawErrorLines.join('; ').substring(0,500)}... Failing build.`);
              throw new Error(`Project build failed: ${errorMsg}. Unable to identify specific file for AI fix or AI fix already attempted.`);
            }
          } else { // Failed on 2nd attempt or AI fix not applicable
            throw new Error(`Project build failed on attempt ${attempt}: ${errorMsg}`);
          }
        }
      } // End of build attempts loop
    } else { // Not a buildable project (static)
      internalLogs.push(`${logPrefix} [Step 5-6/8] Static site or no build command. Using project root '${effectiveProjectRoot}' for S3 upload.`);
      sourcePathForUpload = effectiveProjectRoot; 
    }

    internalLogs.push(`${logPrefix} [Step 7/8] Uploading files from ${sourcePathForUpload} to S3...`);
    const s3ProjectBaseKey = `users/${userId}/sites/${finalProjectName}`; 
    await uploadDirectoryRecursiveS3(sourcePathForUpload, s3ProjectBaseKey, internalLogs);
    internalLogs.push(`${logPrefix} Files uploaded successfully to S3.`);

    const deployedUrl = `/sites/${s3ProjectBaseKey}/`; // This path is relative to the app's domain, served by /sites/[...filePath]/route.ts
    internalLogs.push(`${logPrefix} [Step 8/8] Deployment successful! Site should be accessible at: ${deployedUrl}`);
    
    // Store deployment info in Firestore
    if (db) {
      try {
        const projectDocRef = doc(db, `users/${userId}/projects/${parentDeploymentId}`);
        await setDoc(projectDocRef, {
          projectName: finalProjectName,
          deployedUrl: deployedUrl,
          s3Path: s3ProjectBaseKey,
          deploymentId: parentDeploymentId,
          framework: frameworkDetectionResult.framework,
          createdAt: Timestamp.now(), // Use Firestore Timestamp
        });
        internalLogs.push(`${logPrefix} Successfully saved deployment record to Firestore for deployment ID ${parentDeploymentId}.`);
      } catch (firestoreError: any) {
        const firestoreErrorMsg = extractErrorMessage(firestoreError);
        internalLogs.push(`${logPrefix} WARNING: Failed to save deployment record to Firestore: ${firestoreErrorMsg}`);
        console.error(`${logPrefix} Firestore save error for deployment ${parentDeploymentId}:`, firestoreError);
        // Do not fail the entire deployment for a Firestore write error, but log it.
      }
    } else {
        internalLogs.push(`${logPrefix} WARNING: Firestore DB instance not available. Skipping save of deployment record.`);
    }


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
      deploymentId: parentDeploymentId,
    };

  } catch (error: any) {
    const errorDetail = extractErrorMessage(error);
    const errorName = error instanceof Error ? error.name : "UnknownErrorInPerformFullDeployment";
    console.error(`${logPrefix} CRITICAL FAILURE. User: ${userId}, Project: ${finalProjectNameForErrorHandling}. Error (${errorName}): ${errorDetail}`, error.stack || error);
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
        deploymentId: parentDeploymentId,
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

export async function deployProject(formData: FormData): Promise<DeploymentResult> {
  const actionDeploymentId = `deploy-${Date.now()}-${Math.random().toString(36).substring(2, 9)}`;
  const actionLogPrefix = `[deployProject:${actionDeploymentId}]`;
  
  let projNameForError = 'unknown-project-early-error';

  let resultForReturn: DeploymentResult = { 
    success: false,
    message: `Deployment action (ID: ${actionDeploymentId}) initiated but an unexpected error occurred before main processing.`,
    projectName: projNameForError,
    error: 'Pre-processing error or unhandled exception in deployment action. Check server logs.',
    logs: [`${actionLogPrefix} Error: Action did not complete. Incident ID: ${actionDeploymentId}`],
    deploymentId: actionDeploymentId,
  };

  try {
    console.log(`${actionLogPrefix} Entered function. Validating input...`);
    const file = formData.get('zipfile') as File | null;
    const githubUrl = formData.get('githubUrl') as string | null;
    const userId = formData.get('userId') as string | null; // Get userId

    if (!userId) {
        const errorMsg = "User ID is missing. Cannot proceed with deployment.";
        console.error(`${actionLogPrefix} Input validation CRITICAL: ${errorMsg}`);
        return { 
            success: false, 
            message: errorMsg, 
            projectName: projNameForError, 
            error: errorMsg, 
            logs: [`${actionLogPrefix} Validation Error: ${errorMsg}`],
            deploymentId: actionDeploymentId,
        };
    }
    console.log(`${actionLogPrefix} Operating for userId: ${userId}`);

    if (file) {
        projNameForError = sanitizeName(file.name) || `zipfile-${actionDeploymentId.substring(7,12)}`;
        console.log(`${actionLogPrefix} Source: ZIP file - Name='${file.name}', Size=${file.size}, Type='${file.type}'`);
        if (!file.name.toLowerCase().endsWith('.zip') && file.type !== 'application/zip' && file.type !== 'application/x-zip-compressed') {
            const errorMsg = `Invalid file type: "${file.name}". Only .zip files are allowed. Detected type: ${file.type}.`;
            console.error(`${actionLogPrefix} Input validation CRITICAL: ${errorMsg}`);
            return { 
                success: false, 
                message: errorMsg, 
                projectName: projNameForError, 
                error: errorMsg, 
                logs: [`${actionLogPrefix} Validation Error: ${errorMsg}`],
                deploymentId: actionDeploymentId,
            };
        }
    } else if (githubUrl) {
        projNameForError = sanitizeName(githubUrl) || `github-${actionDeploymentId.substring(7,12)}`;
        console.log(`${actionLogPrefix} Source: GitHub URL - '${githubUrl}'`);
         if (!githubUrl.match(/^(https?:\/\/)?(www\.)?github\.com\/[\w-]+\/[\w.-]+(\.git)?$/i)) {
            const errorMsg = `Invalid GitHub URL format: ${githubUrl}. Expected format like 'https://github.com/user/repo'.`;
            console.error(`${actionLogPrefix} Input validation CRITICAL: ${errorMsg}`);
             return { 
                success: false, 
                message: errorMsg, 
                projectName: projNameForError, 
                error: errorMsg, 
                logs: [`${actionLogPrefix} Validation Error: ${errorMsg}`],
                deploymentId: actionDeploymentId,
            };
        }
    } else {
        projNameForError = 'no-source-provided';
         const errorMsg = "No ZIP file or GitHub URL provided. Please provide one source.";
         console.error(`${actionLogPrefix} Input validation CRITICAL: ${errorMsg}`);
         return { 
            success: false, 
            message: errorMsg, 
            projectName: projNameForError, 
            error: errorMsg, 
            logs: [`${actionLogPrefix} Validation Error: ${errorMsg}`],
            deploymentId: actionDeploymentId,
        };
    }
    resultForReturn.projectName = projNameForError; 

    console.log(`${actionLogPrefix} Input validated. Calling performFullDeployment for user '${userId}', project context: '${projNameForError}', parentId: '${actionDeploymentId}'...`);
    
    const fullDeploymentOutcome = await performFullDeployment(userId, formData, actionDeploymentId);
    
    if (
        fullDeploymentOutcome &&
        typeof fullDeploymentOutcome.success === 'boolean' &&
        typeof fullDeploymentOutcome.message === 'string' &&
        Array.isArray(fullDeploymentOutcome.logs)
    ) {
        resultForReturn = fullDeploymentOutcome;
    } else {
        const malformedResponseStr = JSON.stringify(fullDeploymentOutcome).substring(0, 200);
        console.error(`${actionLogPrefix} CRITICAL: performFullDeployment returned an invalid or malformed structure. Response (partial): ${malformedResponseStr}`);
        resultForReturn = {
            success: false,
            message: `Deployment process for '${projNameForError}' failed due to an internal server error (malformed core result).`,
            projectName: projNameForError,
            error: 'Internal server error: Malformed result from core deployment. Check server logs.',
            logs: [
                `${actionLogPrefix} Critical: Core deployment function returned malformed data.`,
                `${actionLogPrefix} Received (partial): ${malformedResponseStr}...`,
                `Incident ID: ${actionDeploymentId}`,
                `Project Context: ${projNameForError}`
            ],
            deploymentId: actionDeploymentId,
        };
    }
    console.log(`${actionLogPrefix} performFullDeployment processing finished. Apparent Success: ${resultForReturn.success}, Project: '${resultForReturn.projectName}', Deployed URL: ${resultForReturn.deployedUrl || 'N/A'}`);

  } catch (error: any) {
    const errorMsg = extractErrorMessage(error);
    const errorName = error instanceof Error ? error.name : "UnknownErrorInDeployProjectMainCatch";
    console.error(`${actionLogPrefix} CRITICAL UNHANDLED error in deployProject's main try block. Error (${errorName}) for project '${projNameForError}': ${errorMsg}`, error instanceof Error ? error.stack : error);
    
    resultForReturn = {
        success: false,
        message: `Deployment process for '${projNameForError}' encountered a critical server error: ${errorMsg}. (Incident: ${actionDeploymentId})`,
        projectName: projNameForError,
        error: errorMsg, 
        logs: [
            `${actionLogPrefix} Critical server error: ${errorMsg}`,
            `${actionLogPrefix} Project context: '${projNameForError}'`,
            `${actionLogPrefix} Incident ID: '${actionDeploymentId}'`,
            `${actionLogPrefix} Please check detailed server logs.`
        ],
        deploymentId: actionDeploymentId,
    };
  } finally {
    try {
      const finalResultToLog = resultForReturn || { success: false, message: "Result object was unexpectedly null/undefined in finally block."};
      console.log(`${actionLogPrefix} Final result being returned to client (Deployment ID: ${finalResultToLog.deploymentId || actionDeploymentId}): Success=${finalResultToLog.success}, Msg=${(finalResultToLog.message || '').substring(0,150)}..., Project='${finalResultToLog.projectName || projNameForError}'`);
    } catch (loggingError: any) {
        console.error(`${actionLogPrefix} CRITICAL: Could not serialize or log final result in 'finally' block. Error: ${extractErrorMessage(loggingError)}. Deployment ID: ${actionDeploymentId}`);
    }
  }
  
  return resultForReturn; 
}
