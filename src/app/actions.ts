
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
import { fixCodeInFile, type FixCodeInput, type FixCodeOutput } from '@/ai/flows/fix-code-flow';

const execAsync = promisify(exec);
const MAX_AI_FIX_ATTEMPTS = 1; // Try to fix with AI at most once per build attempt cycle

export interface DeploymentResult {
  success: boolean;
  message: string;
  projectName?: string;
  deployedUrl?: string;
  error?: string;
  logs: string[];
}

// Simplified error message extraction
function extractErrorMessage(error: any): string {
  const defaultMessage = 'An unknown error occurred during deployment.';
  const maxLength = 350; // Max length for extracted error messages

  if (!error) return defaultMessage;

  let extractedMessage: string;

  if (error instanceof Error) {
    let message = error.message || defaultMessage;
    // if (error.name && error.name !== 'Error') { // Avoid generic "Error: " prefix if name is just "Error"
    //   message = `${error.name}: ${message}`;
    // }
    extractedMessage = message;
  } else if (typeof error === 'string') {
    extractedMessage = error || defaultMessage;
  } else {
    try {
      const stringified = JSON.stringify(error);
      if (stringified === '{}' && Object.keys(error).length === 0 && !(error instanceof Date)) {
        extractedMessage = defaultMessage;
      } else {
        extractedMessage = stringified;
      }
    } catch (e) {
      extractedMessage = `Could not stringify error object. Original error type: ${Object.prototype.toString.call(error)}. ${defaultMessage}`;
    }
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
    const cleanEntryName = entry.name.replace(/^\/+|\/+$/g, ''); // Sanitize entry name
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
    .replace(/\.zip$/i, '') // Remove .zip extension
    .replace(/\.git$/i, '') // Remove .git extension
    .replace(/\/$/, '') // Remove trailing slash if it's a path component
    .split('/') // Get the last component if it's a path
    .pop() || 'untitled-project' // Fallback if split/pop fails
    .replace(/\s+/g, '-') // Replace spaces with hyphens
    .replace(/[^a-zA-Z0-9-]/g, '') // Remove non-alphanumeric characters except hyphens
    .replace(/-+/g, '-') // Replace multiple hyphens with a single one
    .replace(/^-+|-+$/g, '') // Trim leading/trailing hyphens
    .toLowerCase() || 'untitled-project'; // Fallback to ensure it's not empty
};

interface FrameworkDetectionResult {
  framework: string; // e.g., "nextjs", "cra", "vite-react", "static", "generic-react", "custom-build"
  build_command?: string;
  output_directory?: string;
  reasoning?: string;
  project_type_context?: string; // e.g., "Next.js TypeScript Project" for AI
}

// Updated nonAIDetectFramework to provide project_type_context
function nonAIDetectFramework(packageJsonContent: string | null, fileNameAnalyzed: string, logs: string[]): FrameworkDetectionResult {
  const logPrefix = `[nonAIDetectFramework]`;
  logs.push(`${logPrefix} Input file for analysis: ${fileNameAnalyzed}.`);
  if (packageJsonContent && fileNameAnalyzed.includes('package.json')) {
    logs.push(`${logPrefix} Analyzing package.json...`);
    try {
      const pkg = JSON.parse(packageJsonContent);
      const dependencies = { ...pkg.dependencies, ...pkg.devDependencies };
      const scripts = pkg.scripts || {};
      const isTypeScript = !!(dependencies.typescript || pkg.types || pkg.typings); // Basic TS check

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
      logs.push(`${logPrefix} Error parsing package.json: ${extractErrorMessage(e)}. Assuming static.`);
      return { framework: 'static', reasoning: `Failed to parse package.json: ${extractErrorMessage(e)}`, project_type_context: 'Static project (package.json parse error)' };
    }
  } else if (fileNameAnalyzed.includes('index.html')) {
    logs.push(`${logPrefix} No package.json prioritized. index.html found. Assuming static.`);
    return { framework: 'static', reasoning: "index.html found, no package.json prioritized.", project_type_context: 'Static HTML project' };
  }

  logs.push(`${logPrefix} No package.json or index.html found for analysis. Assuming static.`);
  return { framework: 'static', reasoning: "No definitive project files (package.json, index.html) found for analysis.", project_type_context: 'Static project (no indicative files)' };
}

interface ParsedError {
  filePath: string;
  errorMessage: string;
  lineNumber?: number; // Optional, as not all errors provide this easily
}

// Simplified build error parser - This is a placeholder and needs significant improvement for robustness.
// It will only catch very basic patterns.
function parseBuildErrors(logOutput: string, projectRootPath: string, logs: string[]): ParsedError[] {
  const errors: ParsedError[] = [];
  const logPrefix = `[parseBuildErrors]`;
  logs.push(`${logPrefix} Attempting to parse build errors from logs.`);

  // Regex for TypeScript/JavaScript errors (e.g., "src/file.ts(10,5): error TS2339: Property 'x' does not exist...")
  // Or simple "ERROR in ./src/file.js" followed by message lines
  const errorRegexPatterns = [
    // Basic tsc/eslint style: relative/path/to/file.ext(line,col): error CODE: Message
    /(?:[./\w-]+[/\\])?([\w.-]+[/\\ \w.-]+\.(?:ts|tsx|js|jsx|mjs|cjs))\s?\((\d+),(\d+)\):\s(?:error|warning)\s+([A-Z0-9]+):\s*(.+)/gi,
    // Webpack style: ERROR in ./path/to/file.js \n Message
    /ERROR in ([\w./\\-]+)\n([\s\S]*?)(?=\n\n|ERROR in|$)/gi,
    // Generic: path/to/file.ext \n error: Message
    /([\w./\\-]+?\.(?:ts|tsx|js|jsx|mjs|cjs))\s*\n\s*error:\s*(.+)/gi
  ];

  for (const regex of errorRegexPatterns) {
      let match;
      while ((match = regex.exec(logOutput)) !== null) {
          let filePath = match[1];
          let errorMessage = regex.source.includes("ERROR in") ? match[2].trim() : match[5] || match[2].trim();
          let lineNumber = regex.source.includes("(") ? parseInt(match[2], 10) : undefined;

          // Try to make filePath relative to projectRootPath if it's absolute in the log
          if (path.isAbsolute(filePath) && filePath.startsWith(projectRootPath)) {
              filePath = path.relative(projectRootPath, filePath);
          }
          // Normalize path separators
          filePath = filePath.replace(/\\/g, '/');


          if (filePath && errorMessage) {
              // Avoid adding duplicate errors for the same file and rough message start
              if (!errors.some(e => e.filePath === filePath && e.errorMessage.startsWith(errorMessage.substring(0,30)))) {
                 logs.push(`${logPrefix} Parsed error: File='${filePath}', Line=${lineNumber || 'N/A'}, Message='${errorMessage.substring(0, 100)}...'`);
                 errors.push({ filePath, errorMessage, lineNumber });
              }
          }
      }
  }
  
  if(errors.length === 0) {
    logs.push(`${logPrefix} No specific file errors parsed from build log. The error might be more general.`);
  }
  return errors;
}


async function performFullDeployment(
  userId: string, // Keep userId for potential future use in S3 paths etc.
  formData: FormData
): Promise<DeploymentResult> {
  const internalLogs: string[] = [];
  const deploymentIdForLogging = `deploy-${Date.now()}`;
  const logPrefix = `[performFullDeployment:${deploymentIdForLogging}]`;
  internalLogs.push(`--- ${logPrefix} Process Started for user: ${userId} ---`);

  let uniqueTempIdDir: string | null = null;
  let finalProjectNameForErrorHandling = 'untitled-project-setup-phase';
  let projectRootPath = ''; // This will be the effective root of the user's project code

  try {
    internalLogs.push(`${logPrefix} [Step 1/9] Validating S3 config and creating temp directories...`);
    s3Client(); // Check S3 config early
    if (!OLA_S3_BUCKET_NAME) {
        internalLogs.push(`${logPrefix} CRITICAL: OLA_S3_BUCKET_NAME is not configured. Aborting.`);
        throw new MissingS3ConfigError('S3 bucket name (OLA_S3_BUCKET_NAME) is not configured.');
    }
    await ensureDirectoryExists(TEMP_UPLOAD_DIR, internalLogs, "TempUploadDirSetup");
    const uniqueIdSuffix = Math.random().toString(36).substring(2, 9);
    uniqueTempIdDir = path.join(TEMP_UPLOAD_DIR, `deploy-${deploymentIdForLogging.substring(0,8)}-${uniqueIdSuffix}`);
    await ensureDirectoryExists(uniqueTempIdDir, internalLogs, "UniqueTempDirSetup");
    internalLogs.push(`${logPrefix} Unique temporary directory: ${uniqueTempIdDir}`);

    const githubUrl = formData.get('githubUrl') as string | null;
    const file = formData.get('zipfile') as File | null;

    if (!file && !githubUrl) throw new Error('No file uploaded and no GitHub URL provided.');
    if (file && githubUrl) throw new Error('Both a file and a GitHub URL were provided. Please provide only one source.');

    let sourceNameForProject = 'untitled-project';
    let baseExtractionDir = uniqueTempIdDir; // Files will be extracted/cloned directly into uniqueTempIdDir

    internalLogs.push(`${logPrefix} [Step 2/9] Processing project source...`);
    if (githubUrl) {
      internalLogs.push(`${logPrefix} GitHub URL provided: ${githubUrl}`);
      if (!githubUrl.match(/^(https?:\/\/)?(www\.)?github\.com\/[\w-]+\/[\w.-]+(\.git)?$/i)) {
        throw new Error(`Invalid GitHub URL format: ${githubUrl}.`);
      }
      projectRootPath = path.join(uniqueTempIdDir, 'cloned_repo'); // Clone into a subfolder
      await ensureDirectoryExists(projectRootPath, internalLogs, "GitCloneDirSetup");
      internalLogs.push(`${logPrefix} Attempting to clone ${githubUrl} into ${projectRootPath}...`);
      try {
        const cloneOutput = await execAsync(`git clone --depth 1 ${githubUrl} .`, { cwd: projectRootPath });
        if (cloneOutput.stdout) internalLogs.push(`${logPrefix} Git clone stdout:\n${cloneOutput.stdout}`);
        if (cloneOutput.stderr) internalLogs.push(`${logPrefix} Git clone stderr (may not be an error):\n${cloneOutput.stderr}`);
        internalLogs.push(`${logPrefix} Repository cloned successfully into ${projectRootPath}.`);
        sourceNameForProject = githubUrl;
      } catch (cloneError: any) {
        const errorMsg = extractErrorMessage(cloneError);
        internalLogs.push(`${logPrefix} Error cloning repository: ${errorMsg}`);
        if (cloneError.stdout) internalLogs.push(`${logPrefix} Git clone stdout (on error):\n${cloneError.stdout}`);
        if (cloneError.stderr) internalLogs.push(`${logPrefix} Git clone stderr (on error):\n${cloneError.stderr}`);
        throw new Error(`Failed to clone repository: ${errorMsg}.`);
      }
    } else if (file) {
      internalLogs.push(`${logPrefix} ZIP file provided: ${file.name}`);
      if (!file.name.toLowerCase().endsWith('.zip') && file.type !== 'application/zip' && file.type !== 'application/x-zip-compressed') {
         throw new Error(`Uploaded file "${file.name}" is not a .zip file. Detected type: ${file.type}.`);
      }
      projectRootPath = path.join(uniqueTempIdDir, 'extracted_zip'); // Extract into a subfolder
      await ensureDirectoryExists(projectRootPath, internalLogs, "ZipExtractDirSetup");
      const fileBuffer = Buffer.from(await file.arrayBuffer());
      const zip = await JSZip.loadAsync(fileBuffer);
      let extractedFileCount = 0;
      for (const relativePathInZip in zip.files) {
        const zipEntry = zip.files[relativePathInZip];
        const localDestPath = path.join(projectRootPath, relativePathInZip);
        if (!localDestPath.startsWith(projectRootPath + path.sep) && localDestPath !== projectRootPath) {
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
      internalLogs.push(`${logPrefix} ZIP extracted to ${projectRootPath}. Files extracted: ${extractedFileCount}`);
      if (extractedFileCount === 0) throw new Error('The uploaded ZIP file is empty or contains only directories.');
      sourceNameForProject = file.name;
    }

    internalLogs.push(`${logPrefix} [Step 3/9] Sanitizing project name from: ${sourceNameForProject}`);
    const finalProjectName = sanitizeName(sourceNameForProject) || `web-deploy-${deploymentIdForLogging.substring(0, 5)}`;
    finalProjectNameForErrorHandling = finalProjectName;
    internalLogs.push(`${logPrefix} Using project name: ${finalProjectName}`);

    internalLogs.push(`${logPrefix} [Step 4/9] Determining effective project root and detecting framework...`);
    // At this point, `projectRootPath` should be the root of the user's code.
    // We need to find package.json or index.html *within* this root.
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
             if (!newRelativePath.includes('/build/') && !newRelativePath.includes('/dist/')) { // Avoid picking up built index.htmls
                indexHtmlPaths.push(newRelativePath);
            }
          }
        }
      };
      await findFilesRecursive(searchBaseDir, ''); // Start with empty relative path from searchBaseDir
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
    
    // `projectRootPath` is where files were cloned/extracted.
    const analysisResult = await findAnalysisFile(projectRootPath);
    const effectiveProjectRoot = analysisResult.effectiveProjectRoot; // This is where package.json or index.html lives, or the extraction root.
    projectRootPath = effectiveProjectRoot; // Update projectRootPath to the *actual* root of the project files.
    internalLogs.push(`${logPrefix} Effective project root for build operations: ${projectRootPath}`);

    let frameworkDetectionResult: FrameworkDetectionResult;
    if (analysisResult.relativePath && analysisResult.content) {
        internalLogs.push(`${logPrefix} Framework detection using file: '${analysisResult.relativePath}' (relative to extraction/clone root).`);
        frameworkDetectionResult = nonAIDetectFramework(analysisResult.content, analysisResult.relativePath, internalLogs);
    } else {
        internalLogs.push(`${logPrefix} No specific analysis file found. Assuming static.`);
        frameworkDetectionResult = nonAIDetectFramework(null, 'none_found_in_search', internalLogs);
    }
    internalLogs.push(`${logPrefix} Detected framework: ${frameworkDetectionResult.framework}. Build cmd: ${frameworkDetectionResult.build_command || 'N/A'}. Output dir: ${frameworkDetectionResult.output_directory || 'N/A'}. Context: ${frameworkDetectionResult.project_type_context || 'N/A'}`);

    const needsBuild = frameworkDetectionResult.framework !== 'static' && frameworkDetectionResult.build_command;
    let finalBuildSourcePath = projectRootPath; // For static sites, this is the root. For built, it's output_directory.
    let aiFixAttempts = 0;
    let buildSucceeded = !needsBuild; // Static sites "succeed" build immediately.

    if (needsBuild && frameworkDetectionResult.build_command) {
      internalLogs.push(`${logPrefix} [Step 5/9] Project requires build. Starting build process...`);
      
      while (aiFixAttempts <= MAX_AI_FIX_ATTEMPTS) {
        if (aiFixAttempts > 0) {
          internalLogs.push(`${logPrefix} --- Retrying build (Attempt ${aiFixAttempts + 1}/${MAX_AI_FIX_ATTEMPTS + 1}) after AI fix attempt ---`);
        }

        // NPM Install
        internalLogs.push(`${logPrefix} Running 'npm install --legacy-peer-deps --prefer-offline --no-audit --progress=false' in ${projectRootPath}...`);
        try {
          const installOutput = await execAsync('npm install --legacy-peer-deps --prefer-offline --no-audit --progress=false', { cwd: projectRootPath });
          if(installOutput.stdout) internalLogs.push(`${logPrefix} npm install stdout:\n${installOutput.stdout}`);
          if(installOutput.stderr) internalLogs.push(`${logPrefix} npm install stderr (may not be error):\n${installOutput.stderr}`);
        } catch (installError: any) {
          const errorMsg = extractErrorMessage(installError);
          internalLogs.push(`${logPrefix} npm install FAILED: ${errorMsg}`);
          if (installError.stdout) internalLogs.push(`${logPrefix} npm install stdout (on error):\n${installError.stdout}`);
          if (installError.stderr) internalLogs.push(`${logPrefix} npm install stderr (on error):\n${installError.stderr}`);
          // For install errors, AI fix is unlikely to help. Throw to fail the deployment.
          throw new Error(`npm install failed: ${errorMsg}. Check project dependencies and logs.`);
        }
        internalLogs.push(`${logPrefix} npm install completed.`);

        // Build Command Execution
        let buildCommandToExecute = frameworkDetectionResult.build_command;
        const buildEnv = { ...process.env };
        const publicUrlForAssets = `/sites/users/${userId}/sites/${finalProjectName}`; // Define public URL if needed by build

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
        }
        
        internalLogs.push(`${logPrefix} Executing build command: '${buildCommandToExecute}' in ${projectRootPath}`);
        let buildOutputLogs = '';
        try {
          const buildOutput = await execAsync(buildCommandToExecute, { cwd: projectRootPath, env: buildEnv });
          if(buildOutput.stdout) {
            internalLogs.push(`${logPrefix} Build command stdout:\n${buildOutput.stdout}`);
            buildOutputLogs += buildOutput.stdout;
          }
          if(buildOutput.stderr) {
            internalLogs.push(`${logPrefix} Build command stderr (may not be error):\n${buildOutput.stderr}`);
            buildOutputLogs += buildOutput.stderr; // stderr can contain warnings or actual errors
          }
          buildSucceeded = true;
          internalLogs.push(`${logPrefix} Build command SUCCEEDED.`);
          break; // Exit build loop on success
        } catch (buildError: any) {
          const errorMsg = extractErrorMessage(buildError);
          internalLogs.push(`${logPrefix} Build command FAILED: ${errorMsg}`);
          if (buildError.stdout) {
            internalLogs.push(`${logPrefix} Build command stdout (on error):\n${buildError.stdout}`);
            buildOutputLogs += buildError.stdout;
          }
          if (buildError.stderr) {
            internalLogs.push(`${logPrefix} Build command stderr (on error):\n${buildError.stderr}`);
            buildOutputLogs += buildError.stderr;
          }

          if (aiFixAttempts >= MAX_AI_FIX_ATTEMPTS) {
            internalLogs.push(`${logPrefix} Max AI fix attempts reached. Failing deployment.`);
            throw new Error(`Project build failed after ${MAX_AI_FIX_ATTEMPTS +1} attempt(s): ${errorMsg}`);
          }

          internalLogs.push(`${logPrefix} [Step 6/9] Attempting AI fix for build errors (Attempt ${aiFixAttempts + 1})...`);
          const parsedErrors = parseBuildErrors(buildOutputLogs, projectRootPath, internalLogs);

          if (parsedErrors.length === 0) {
            internalLogs.push(`${logPrefix} No specific file errors parsed from build log. Cannot attempt AI fix. Failing deployment.`);
            throw new Error(`Project build failed, and no specific file errors could be parsed for AI fix: ${errorMsg}`);
          }
          
          // For simplicity, attempt to fix only the first parsed error.
          const errorToFix = parsedErrors[0];
          internalLogs.push(`${logPrefix} AI will attempt to fix: ${errorToFix.filePath} - ${errorToFix.errorMessage.substring(0,100)}...`);
          
          const fullPathToErrorFile = path.join(projectRootPath, errorToFix.filePath);
          let originalFileContent = '';
          try {
            originalFileContent = await fs.readFile(fullPathToErrorFile, 'utf-8');
          } catch (fileReadError: any) {
            internalLogs.push(`${logPrefix} Could not read file '${errorToFix.filePath}' for AI fix: ${extractErrorMessage(fileReadError)}. Aborting AI fix.`);
            throw new Error(`Project build failed. Could not read file for AI fix: ${errorToFix.filePath}`);
          }

          const aiFixInput: FixCodeInput = {
            filePath: errorToFix.filePath,
            fileContent: originalFileContent,
            errorMessage: errorToFix.errorMessage,
            projectContext: frameworkDetectionResult.project_type_context || 'Unknown project type'
          };

          try {
            internalLogs.push(`${logPrefix} Calling AI to fix code in '${aiFixInput.filePath}'...`);
            const aiFixResult = await fixCodeInFile(aiFixInput);
            internalLogs.push(`${logPrefix} AI Fix Result: Applied=${aiFixResult.fixApplied}, Confidence=${aiFixResult.confidence || 'N/A'}. Reasoning: ${aiFixResult.reasoning || 'No reasoning provided.'}`);

            if (aiFixResult.fixApplied && aiFixResult.fixedFileContent && aiFixResult.fixedFileContent !== originalFileContent) {
              await fs.writeFile(fullPathToErrorFile, aiFixResult.fixedFileContent, 'utf-8');
              internalLogs.push(`${logPrefix} AI applied fix to '${errorToFix.filePath}'.`);
            } else {
              internalLogs.push(`${logPrefix} AI did not apply a fix to '${errorToFix.filePath}'. Retrying build with original code for this file (or other fixes might have been applied).`);
              // If AI didn't apply a fix, we still increment attempt and retry the build,
              // as the issue might be elsewhere or the log parsing picked the wrong error.
            }
          } catch (aiError: any) {
            internalLogs.push(`${logPrefix} Error calling AI for code fix: ${extractErrorMessage(aiError)}. Proceeding to retry build without this AI fix.`);
          }
          aiFixAttempts++;
          // Loop back to retry build
        }
      } // End of build loop

      if (!buildSucceeded) {
        // Should be caught by throw inside the loop, but as a safeguard:
        throw new Error("Project build failed after all attempts.");
      }
      
      // Determine final build source path
      const detectedOutputDirName = frameworkDetectionResult.output_directory;
      let foundBuildOutputDir = '';
      if (detectedOutputDirName) {
          const potentialPath = path.join(projectRootPath, detectedOutputDirName);
          try {
              await fs.access(potentialPath); // Check if path exists
              if ((await fs.stat(potentialPath)).isDirectory()) { // Check if it's a directory
                  foundBuildOutputDir = potentialPath;
                  internalLogs.push(`${logPrefix} Build output successfully found at primary path: ${foundBuildOutputDir}`);
              }
          } catch { /* path does not exist or not a dir */ }
      }

      if (!foundBuildOutputDir) {
        const commonOutputDirs = ['dist', 'build', 'out', '.next', 'public', '.output/public', '.svelte-kit/output/client'];
        internalLogs.push(`${logPrefix} Primary build output directory '${detectedOutputDirName || 'N/A'}' not confirmed. Fallback searching: ${commonOutputDirs.join(', ')} in ${projectRootPath}`);
        for (const dir of commonOutputDirs) {
          if (detectedOutputDirName === dir && !foundBuildOutputDir) continue; // Already checked
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
        throw new Error(`Build output directory not found in ${projectRootPath} after build. Expected: '${detectedOutputDirName || 'various defaults'}'.`);
      }
      finalBuildSourcePath = foundBuildOutputDir;
      internalLogs.push(`${logPrefix} Build successful. Source for S3 upload: ${finalBuildSourcePath}`);

    } else {
      internalLogs.push(`${logPrefix} [Step 5-7/9] Static site or no build command. Using project root '${projectRootPath}' for S3 upload.`);
      // finalBuildSourcePath is already projectRootPath
    }

    internalLogs.push(`${logPrefix} [Step 8/9] Uploading files from ${finalBuildSourcePath} to S3...`);
    const s3ProjectBaseKey = `users/${userId}/sites/${finalProjectName}`; // Keep some user scoping
    await uploadDirectoryRecursiveS3(finalBuildSourcePath, s3ProjectBaseKey, internalLogs);
    internalLogs.push(`${logPrefix} Files uploaded successfully to S3.`);

    const deployedUrl = `/sites/${s3ProjectBaseKey}/`; // S3 key path directly
    internalLogs.push(`${logPrefix} [Step 9/9] Deployment successful! Site should be accessible at: ${deployedUrl}`);
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
        internalLogs.push(`Stack Trace (condensed for server log):\n${error.stack.substring(0, 500)}...`);
    }
    const clientErrorLogs: string[] = [
        `Deployment error for project: ${finalProjectNameForErrorHandling}.`,
        `Details: ${errorMessage}`,
        `Incident ID: ${deploymentIdForLogging}`
    ];
     if (error instanceof MissingS3ConfigError) {
      clientErrorLogs.push("This may be due to missing S3 configuration. Please check server environment variables.");
    }
    return {
        success: false,
        message: `Deployment failed: ${errorMessage}`,
        projectName: finalProjectNameForErrorHandling || 'error-handling-project',
        error: errorMessage,
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
        console.error(cleanupMessage, cleanupError.stack);
      }
    } else {
       internalLogs.push(`${logFinallyPrefix} Skipped deletion of temp directory (path issue or not set): ${uniqueTempIdDir || 'Not Set'}`);
    }
    // For debugging, you might want to see full logs on the server console
    // console.log(`${logPrefix} Full internal logs:\n${internalLogs.join('\n')}`);
  }
}


// deployProject remains the main entry point, structure mostly the same.
export async function deployProject(formData: FormData): Promise<DeploymentResult> {
  const actionLogPrefix = "[deployProject:Action]";
  let projNameForError: string = 'unknown-project-early-error';
  
  let resultForReturn: DeploymentResult = {
    success: false,
    message: 'Deployment action initiated but an unexpected error occurred before processing could complete.',
    projectName: projNameForError,
    error: 'Pre-processing error or unhandled exception in deployment action.',
    logs: [`${actionLogPrefix} Error: Action did not complete as expected. Default error response triggered.`],
  };

  try {
    console.log(`${actionLogPrefix} Entered function.`);
    const userId = 'default-user'; // Using a default user ID as auth is currently bypassed

    // Determine project name for error handling early
    const file = formData.get('zipfile') as File | null;
    const githubUrl = formData.get('githubUrl') as string | null;
    if (file) {
        projNameForError = sanitizeName(file.name);
        console.log(`${actionLogPrefix} zipfile details: name=${file?.name}, size=${file?.size}, type=${file?.type}`);
        if (!file.name.toLowerCase().endsWith('.zip') && file.type !== 'application/zip' && file.type !== 'application/x-zip-compressed') {
            const errorMsg = `Invalid file type: "${file.name}". Only .zip files are allowed. Detected type: ${file.type}.`;
            console.error(`${actionLogPrefix} CRITICAL: ${errorMsg}`);
            resultForReturn = { success: false, message: errorMsg, projectName: projNameForError, error: errorMsg, logs: [`${actionLogPrefix} Error: ${errorMsg}`]};
            return resultForReturn;
        }
    } else if (githubUrl) {
        projNameForError = sanitizeName(githubUrl);
        console.log(`${actionLogPrefix} githubUrl value: ${githubUrl}`);
    } else {
        projNameForError = 'no-source-provided';
         const errorMsg = "No ZIP file or GitHub URL provided.";
         resultForReturn = { success: false, message: errorMsg, projectName: projNameForError, error: errorMsg, logs: [`${actionLogPrefix} Error: ${errorMsg}`]};
         return resultForReturn;
    }
    resultForReturn.projectName = projNameForError;


    console.log(`${actionLogPrefix} Calling performFullDeployment for user ${userId}, project context: ${projNameForError}...`);
    resultForReturn = await performFullDeployment(userId, formData); 
    console.log(`${actionLogPrefix} performFullDeployment returned. Success: ${resultForReturn.success}, Project: ${resultForReturn.projectName}`);

  } catch (error: any) {
    const errorMsg = extractErrorMessage(error);
    const errorName = error instanceof Error ? error.name : "UnknownErrorInDeployProject";
    console.error(`${actionLogPrefix} CRITICAL UNHANDLED error in deployProject's try block. Error (${errorName}) for project ${projNameForError}: ${errorMsg}`, error instanceof Error ? error.stack : error);
    
    const actionErrorLogs: string[] = [
        `${actionLogPrefix} Critical server error: ${errorMsg}`,
        `Project context: ${projNameForError}`,
        `Incident ID associated with this attempt might be in server logs if performFullDeployment was reached.`
    ];
    
    resultForReturn = {
        success: false,
        message: `Deployment process encountered a critical server error: ${errorMsg}`,
        projectName: projNameForError,
        error: errorMsg,
        logs: actionErrorLogs,
    };
  } finally {
    // Final logging before returning
    try {
        const resultToLog = resultForReturn || {
            success: false, message: "Result object was unexpectedly undefined in deployProject finally block.",
            projectName: projNameForError, error: "Result undefined in finally.",
            logs: ["Critical: resultForReturn was undefined in deployProject finally block."]
        };
        console.log(`${actionLogPrefix} Final result for client: Success=${resultToLog.success}, Msg=${(resultToLog.message || '').substring(0,100)}..., Project=${resultToLog.projectName}`);
    } catch (stringifyError: any) {
        console.error(`${actionLogPrefix} CRITICAL: Could not summarize 'resultForReturn' for logging in 'finally' block. Error: ${extractErrorMessage(stringifyError)}`);
    }
  }
  return resultForReturn;
}
