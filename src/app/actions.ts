
// src/app/actions.ts
'use server';

import fs from 'fs/promises';
import path from 'path';
import { exec } from 'child_process';
import { promisify } from 'util';
import JSZip from 'jszip';
import mime from 'mime-types';
import { PutObjectCommand } from '@aws-sdk/client-s3';
import { s3Client, OLA_S3_BUCKET_NAME } from '@/lib/s3Client';
import { TEMP_UPLOAD_DIR } from '@/config/constants';

const execAsync = promisify(exec);

interface FrameworkDetectionResult {
  framework: string;
  build_command?: string;
  output_directory?: string;
  reasoning?: string;
}

interface DeploymentResult {
  success: boolean;
  message: string;
  projectName?: string;
  deployedUrl?: string;
  logs?: string;
}

async function ensureDirectoryExists(dirPath: string) {
  try {
    await fs.mkdir(dirPath, { recursive: true });
    console.log(`Successfully ensured directory exists: ${dirPath}`);
  } catch (error: any) {
    console.error(`Failed to create directory ${dirPath}:`, error.message, error.stack);
    throw new Error(`Failed to create required directory ${dirPath}: ${error.message}`);
  }
}

async function uploadDirectoryRecursiveS3(
  localDirPath: string,
  s3BaseKey: string,
  logsRef: { value: string }
) {
  if (!OLA_S3_BUCKET_NAME) {
    logsRef.value += 'Error: OLA_S3_BUCKET_NAME is not configured.\n';
    throw new Error('OLA_S3_BUCKET_NAME is not configured for S3 upload.');
  }
  const currentS3Client = s3Client();

  const entries = await fs.readdir(localDirPath, { withFileTypes: true });
  for (const entry of entries) {
    const localEntryPath = path.join(localDirPath, entry.name);
    const cleanEntryName = entry.name.replace(/^\/+|\/+$/g, '');
    const s3ObjectKey = `${s3BaseKey}/${cleanEntryName}`.replace(/^\/+/, '').replace(/\/\//g, '/');


    if (entry.isDirectory()) {
      await uploadDirectoryRecursiveS3(localEntryPath, s3ObjectKey, logsRef);
    } else {
      logsRef.value += `Uploading ${localEntryPath} to S3: s3://${OLA_S3_BUCKET_NAME}/${s3ObjectKey}...\n`;
      const fileBuffer = await fs.readFile(localEntryPath);
      const contentType = mime.lookup(entry.name) || 'application/octet-stream';

      const command = new PutObjectCommand({
        Bucket: OLA_S3_BUCKET_NAME,
        Key: s3ObjectKey,
        Body: fileBuffer,
        ContentType: contentType,
      });
      await currentS3Client.send(command);
      logsRef.value += `Uploaded ${localEntryPath} to s3://${OLA_S3_BUCKET_NAME}/${s3ObjectKey} successfully.\n`;
    }
  }
}

const sanitizeName = (name: string | undefined | null): string => {
  if (!name) return 'untitled-project';
  return name
    .trim()
    .replace(/\.zip$/i, '')
    .replace(/\s+/g, '-')
    .replace(/[^a-zA-Z0-9-]/g, '')
    .replace(/-+/g, '-')
    .replace(/^-+|-+$/g, '')
    .toLowerCase() || 'untitled-project';
};

function nonAIDetectFramework(packageJsonContent: string | null, fileNameAnalyzed: string, logsRef: { value: string }): FrameworkDetectionResult {
  logsRef.value += `Performing non-AI framework detection based on ${fileNameAnalyzed}.\n`;
  if (packageJsonContent && fileNameAnalyzed.includes('package.json')) {
    try {
      const pkg = JSON.parse(packageJsonContent);
      const dependencies = { ...pkg.dependencies, ...pkg.devDependencies };
      const scripts = pkg.scripts || {};

      if (dependencies.next) {
        logsRef.value += "Detected Next.js.\n";
        return { framework: 'nextjs', build_command: scripts.build || 'next build', output_directory: '.next', reasoning: "Next.js dependency found." };
      }
      if (dependencies['@remix-run/dev'] || dependencies.remix) {
        logsRef.value += "Detected Remix.\n";
        return { framework: 'remix', build_command: scripts.build || 'remix build', output_directory: 'public/build', reasoning: "Remix dependency found." };
      }
      if (dependencies['@sveltejs/kit']) {
        logsRef.value += "Detected SvelteKit.\n";
        return { framework: 'sveltekit', build_command: scripts.build || 'vite build', output_directory: '.svelte-kit/output/client', reasoning: "SvelteKit dependency found." }; // Default might be .svelte-kit/output, check specific adapter
      }
      if (dependencies.nuxt) {
        logsRef.value += "Detected Nuxt.js.\n";
        return { framework: 'nuxtjs', build_command: scripts.build || 'npm run build', output_directory: '.output/public', reasoning: "Nuxt.js dependency found." };
      }
      if (dependencies.astro) {
        logsRef.value += "Detected Astro.\n";
        return { framework: 'astro', build_command: scripts.build || 'astro build', output_directory: 'dist', reasoning: "Astro dependency found." };
      }
      if (dependencies.vite && (dependencies['@vitejs/plugin-react'] || dependencies['@vitejs/plugin-react-swc'])) {
        logsRef.value += "Detected Vite with React.\n";
        return { framework: 'vite-react', build_command: scripts.build || 'vite build', output_directory: 'dist', reasoning: "Vite with React plugin detected." };
      }
       if (dependencies['react-scripts']) {
        logsRef.value += "Detected Create React App.\n";
        return { framework: 'cra', build_command: scripts.build || 'npm run build', output_directory: 'build', reasoning: "Create React App (react-scripts) dependency found." };
      }
      if (dependencies.react && dependencies['react-dom']) {
        // This is a fallback for generic React projects if not caught by more specific ones (like CRA or Vite-React)
        logsRef.value += "Detected Generic React project (react and react-dom found).\n";
        return { framework: 'generic-react', build_command: scripts.build || 'npm run build', output_directory: 'dist', reasoning: "Generic React (react and react-dom) dependencies found." };
      }


      logsRef.value += "package.json found, but no clear common framework indicators. Assuming static or custom Node.js build.\n";
      if (scripts.build) {
        // Could be a Node.js app or something else with a build script.
        // Defaulting output to 'dist' is a guess.
        return { framework: 'custom-build', build_command: scripts.build, output_directory: 'dist', reasoning: "package.json with a build script, but unrecognized frontend framework. Assuming 'dist' output." };
      }
      return { framework: 'static', reasoning: "package.json present but no specific framework indicators or standard build script found." };
    } catch (e: any) {
      logsRef.value += `Error parsing package.json: ${e.message}. Assuming static.\n`;
      return { framework: 'static', reasoning: "Failed to parse package.json." };
    }
  } else if (fileNameAnalyzed.includes('index.html')) {
    logsRef.value += "No package.json prioritized. index.html found. Assuming static.\n";
    return { framework: 'static', reasoning: "index.html found, no package.json prioritized." };
  }

  logsRef.value += "No package.json or index.html found for analysis. Assuming static.\n";
  return { framework: 'static', reasoning: "No definitive project files (package.json, index.html) found for analysis." };
}


export async function deployProject(formData: FormData): Promise<DeploymentResult> {
  console.log('deployProject: Action started.');
  let logsRef = { value: 'Deployment Logs:\n----------------\n' };
  let tempZipPath = '';
  let extractionPath = '';
  let projectRootPath = '';
  let finalProjectName = 'untitled-project';
  let frameworkDetectionResult: FrameworkDetectionResult = {
    framework: 'static',
    reasoning: "Initial value before analysis",
  };
  let uniqueExtractionDir: string | null = null;

  try {
    logsRef.value += 'deployProject: Entered main try block.\n';

    // S3 client initialization and configuration checks
    if (!OLA_S3_BUCKET_NAME) {
        logsRef.value += 'Error: S3 bucket name (OLA_S3_BUCKET_NAME) is not configured in environment variables.\n';
        throw new Error('S3 bucket name (OLA_S3_BUCKET_NAME) is not configured.');
    }
    s3Client(); // Initialize client early to catch config errors. Throws on critical config error.
    logsRef.value += 'S3 client initialized and configuration seems present.\n';

    // File handling
    const file = formData.get('zipfile') as File | null;

    if (!file) {
      logsRef.value += 'No file uploaded by the user.\n';
      throw new Error('No file uploaded.');
    }
    logsRef.value += `Received file: ${file.name}, type: ${file.type}, size: ${file.size} bytes.\n`;

    if (file.type !== 'application/zip' && file.type !== 'application/x-zip-compressed') {
      logsRef.value += `Invalid file type received: ${file.type}. Please upload a ZIP file.\n`;
      throw new Error('Invalid file type. Please upload a ZIP file.');
    }

    // Temporary directory setup
    await ensureDirectoryExists(TEMP_UPLOAD_DIR);
    logsRef.value += `Base temporary upload directory ensured: ${TEMP_UPLOAD_DIR}\n`;

    const uniqueId = `${Date.now()}-${Math.random().toString(36).substring(2, 9)}`;
    uniqueExtractionDir = path.join(TEMP_UPLOAD_DIR, uniqueId);
    tempZipPath = path.join(uniqueExtractionDir, file.name);
    extractionPath = path.join(uniqueExtractionDir, 'extracted');
    
    await ensureDirectoryExists(uniqueExtractionDir);
    await ensureDirectoryExists(extractionPath);
    logsRef.value += `Root extraction path for this deployment: ${extractionPath}\n`;

    logsRef.value += `Processing uploaded file: ${file.name}\n`;
    const fileBuffer = Buffer.from(await file.arrayBuffer());
    await fs.writeFile(tempZipPath, fileBuffer);
    logsRef.value += `Temporary ZIP file saved to: ${tempZipPath}\n`;

    const zip = await JSZip.loadAsync(fileBuffer);
    const fileNamesInZip: string[] = [];

    logsRef.value += `Extracting all ZIP files to ${extractionPath}...\n`;
    for (const relativePathInZip in zip.files) {
      fileNamesInZip.push(relativePathInZip);
      const zipEntry = zip.files[relativePathInZip];
      const localDestPath = path.join(extractionPath, relativePathInZip);
      if (zipEntry.dir) {
        await ensureDirectoryExists(localDestPath);
      } else {
        const content = await zipEntry.async('nodebuffer');
        await ensureDirectoryExists(path.dirname(localDestPath));
        await fs.writeFile(localDestPath, content);
      }
    }
    logsRef.value += `ZIP extraction to ${extractionPath} complete.\nAll files from ZIP (first 10): ${fileNamesInZip.slice(0,10).join(', ') || 'None'}${fileNamesInZip.length > 10 ? '...' : ''}\n`;

    if (fileNamesInZip.length === 0) {
      logsRef.value += 'The uploaded ZIP file is empty or invalid.\n';
      throw new Error('The uploaded ZIP file is empty or invalid.');
    }

    logsRef.value += `Determining project name from filename...\n`;
    const fileBasedName = sanitizeName(file.name);
    logsRef.value += `Uploaded file name (raw: "${file.name}", sanitized: "${fileBasedName}")\n`;
    const minNameLength = 3;
    if (fileBasedName && fileBasedName.length >= minNameLength) {
      finalProjectName = fileBasedName;
      logsRef.value += `Using file-based name: ${finalProjectName}\n`;
    } else {
      finalProjectName = 'web-deployment-' + uniqueId.substring(0,5) ;
      logsRef.value += `File-based name unsuitable or too short. Using default name: ${finalProjectName}\n`;
    }

    logsRef.value += `Detecting framework (non-AI)...\n`;
    let analysisFileRelativePath: string | null = null;
    let analysisFileContent: string | null = null;

    const findAnalysisFile = async (currentSearchPath: string, baseExtractionPath: string): Promise<{filePath: string | null, content: string | null, relativePath: string | null}> => {
      const packageJsonPaths: string[] = [];
      const indexHtmlPaths: string[] = [];

      const findFilesRecursive = async (dir: string) => {
        const entries = await fs.readdir(dir, { withFileTypes: true });
        for (const entry of entries) {
          const fullPath = path.join(dir, entry.name);
          const relativeToExtraction = path.relative(baseExtractionPath, fullPath);
          if (entry.isDirectory()) {
            if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
            await findFilesRecursive(fullPath);
          } else if (entry.name.toLowerCase() === 'package.json') {
            packageJsonPaths.push(relativeToExtraction);
          } else if (entry.name.toLowerCase() === 'index.html') {
            if (!relativeToExtraction.includes('/build/') &&
                !relativeToExtraction.includes('/dist/') &&
                !relativeToExtraction.includes('/.next/') &&
                !relativeToExtraction.includes('/.output/') &&
                !relativeToExtraction.includes('/.svelte-kit/') &&
                !relativeToExtraction.includes('/out/') &&
                !relativeToExtraction.includes('/node_modules/')) {
                indexHtmlPaths.push(relativeToExtraction);
            }
          }
        }
      };
      await findFilesRecursive(currentSearchPath);

      packageJsonPaths.sort((a, b) => a.split(path.sep).length - b.split(path.sep).length);
      indexHtmlPaths.sort((a, b) => a.split(path.sep).length - b.split(path.sep).length);

      if (packageJsonPaths.length > 0) {
        const chosenFile = packageJsonPaths[0];
        projectRootPath = path.join(baseExtractionPath, path.dirname(chosenFile));
        return { filePath: path.join(baseExtractionPath, chosenFile), content: await fs.readFile(path.join(baseExtractionPath, chosenFile), 'utf-8'), relativePath: chosenFile };
      }
      if (indexHtmlPaths.length > 0) {
         const chosenFile = indexHtmlPaths[0];
         projectRootPath = path.join(baseExtractionPath, path.dirname(chosenFile));
         return { filePath: path.join(baseExtractionPath, chosenFile), content: await fs.readFile(path.join(baseExtractionPath, chosenFile), 'utf-8'), relativePath: chosenFile };
      }
      projectRootPath = baseExtractionPath;
      return { filePath: null, content: null, relativePath: null };
    };

    const analysisResult = await findAnalysisFile(extractionPath, extractionPath);
    analysisFileRelativePath = analysisResult.relativePath;
    analysisFileContent = analysisResult.content;

    if (analysisFileRelativePath && analysisFileContent) {
        logsRef.value += `Framework detection input: content of '${analysisFileRelativePath}'. Project root set to: ${projectRootPath}\n`;
        frameworkDetectionResult = nonAIDetectFramework(analysisFileContent, analysisFileRelativePath, logsRef);
    } else {
        projectRootPath = extractionPath;
        logsRef.value += `No suitable package.json or index.html found for framework detection. Project root defaulted to: ${projectRootPath}\n`;
        frameworkDetectionResult = nonAIDetectFramework(null, 'none_found', logsRef);
    }

    logsRef.value += `Detected framework: ${frameworkDetectionResult.framework}\n`;
    logsRef.value += `Reasoning: ${frameworkDetectionResult.reasoning || 'N/A'}\n`;

    const needsBuild = frameworkDetectionResult.framework !== 'static' && frameworkDetectionResult.build_command;

    if (needsBuild) {
      logsRef.value += `Build command from detection: ${frameworkDetectionResult.build_command}\n`;
      logsRef.value += `Expected output directory (relative to project root): ${frameworkDetectionResult.output_directory || 'N/A'}\n`;
    }

    const s3ProjectBaseKey = `sites/${finalProjectName}`;
    logsRef.value += `Final detected framework for build process: ${frameworkDetectionResult.framework}\n`;
    logsRef.value += `Project root path for build/upload: ${projectRootPath}\n`;

    if (needsBuild && frameworkDetectionResult.build_command) {
      logsRef.value += `Project needs build. Starting build process in ${projectRootPath}...\n`;
      try {
        logsRef.value += `Running 'npm install --legacy-peer-deps' in ${projectRootPath}...\n`;
        const installOutput = await execAsync('npm install --legacy-peer-deps', { cwd: projectRootPath });
        logsRef.value += `npm install stdout:\n${installOutput.stdout || 'N/A'}\n`;
        if (installOutput.stderr) logsRef.value += `npm install stderr:\n${installOutput.stderr}\n`;

        let buildCommandToExecute = frameworkDetectionResult.build_command;
        const buildEnv = { ...process.env };
        const publicUrlForAssets = `/sites/${finalProjectName}`; 

        if (['cra', 'generic-react'].includes(frameworkDetectionResult.framework)) {
            buildEnv.PUBLIC_URL = publicUrlForAssets;
            logsRef.value += `Setting PUBLIC_URL=${publicUrlForAssets} for build.\n`;
        } else if (frameworkDetectionResult.framework === 'vite-react') {
            const viteBasePath = publicUrlForAssets.endsWith('/') ? publicUrlForAssets : `${publicUrlForAssets}/`;
            buildCommandToExecute = `${buildCommandToExecute} --base=${viteBasePath}`;
            logsRef.value += `Appending --base=${viteBasePath} to Vite build command.\n`;
        }
        else if (['nextjs', 'remix', 'sveltekit', 'nuxtjs', 'astro'].includes(frameworkDetectionResult.framework)) {
            buildEnv.PUBLIC_URL = publicUrlForAssets; // General purpose, might be picked up by some tools
            logsRef.value += `Setting PUBLIC_URL=${publicUrlForAssets} for ${frameworkDetectionResult.framework} build (for potential asset prefixing if framework uses it).\n`;
             if (frameworkDetectionResult.framework === 'nextjs') {
                // For Next.js, `basePath` or `assetPrefix` in next.config.js is the primary way.
                // We are not modifying user's config files. This PUBLIC_URL might not be enough.
                logsRef.value += `Note for Next.js: For proper asset prefixing, ensure 'basePath' or 'assetPrefix' is configured in next.config.js if deploying to a subpath.\n`;
            }
        }

        logsRef.value += `Running build command: '${buildCommandToExecute}' in ${projectRootPath} with relevant env vars...\n`;
        const buildOutput = await execAsync(buildCommandToExecute, { cwd: projectRootPath, env: buildEnv });
        logsRef.value += `Build command stdout:\n${buildOutput.stdout || 'N/A'}\n`;
        if (buildOutput.stderr) logsRef.value += `Build command stderr:\n${buildOutput.stderr}\n`;

        const detectedOutputDir = frameworkDetectionResult.output_directory;
        let buildSourcePath = '';
        if (detectedOutputDir) {
            const potentialPath = path.join(projectRootPath, detectedOutputDir);
            try {
                await fs.access(potentialPath);
                if ((await fs.stat(potentialPath)).isDirectory()) {
                    buildSourcePath = potentialPath;
                    logsRef.value += `Found build output directory at: ${buildSourcePath}\n`;
                }
            } catch { /* Directory does not exist or not accessible */ }
        }

        if (!buildSourcePath) {
          const defaultOutputDirs = ['build', 'dist', 'out', '.next', '.output/public', 'public/build', '.svelte-kit/output/client'];
          for (const dir of defaultOutputDirs) {
            if (detectedOutputDir === dir && buildSourcePath) continue;
            const potentialPath = path.join(projectRootPath, dir);
            try {
              await fs.access(potentialPath);
               if ((await fs.stat(potentialPath)).isDirectory()) {
                  buildSourcePath = potentialPath;
                  logsRef.value += `Found build output directory (fallback search) at: ${buildSourcePath}\n`;
                  frameworkDetectionResult.output_directory = dir;
                  break;
              }
            } catch { /* Directory does not exist or not accessible */ }
          }
        }

        if (!buildSourcePath) {
          logsRef.value += `Error: Build output directory (expected: ${detectedOutputDir || 'N/A'}, also tried fallbacks) not found in ${projectRootPath} after build. Listing directory contents of ${projectRootPath}:\n`;
          try {
            const rootContents = await fs.readdir(projectRootPath, {withFileTypes: true});
            logsRef.value += rootContents.map(entry => `${entry.name}${entry.isDirectory() ? '/' : ''}`).join(', ') + '\n';
          } catch(e: any) { logsRef.value += `Could not list contents of ${projectRootPath}: ${e.message}\nStack: ${e.stack}\n`; }
          throw new Error(`Build output directory not found (expected '${detectedOutputDir || 'various defaults'}'). Check build scripts and output configuration, or ensure PUBLIC_URL/base path settings are compatible.`);
        }

        logsRef.value += `Uploading built files from ${buildSourcePath} to S3 at s3://${OLA_S3_BUCKET_NAME}/${s3ProjectBaseKey}...\n`;
        await uploadDirectoryRecursiveS3(buildSourcePath, s3ProjectBaseKey, logsRef);
        logsRef.value += `Built files uploaded successfully to S3.\n`;

      } catch (buildError: any) {
        logsRef.value += `Build process failed: ${buildError.message}\n`;
        if (buildError.stdout) logsRef.value += `Build stdout:\n${buildError.stdout}\n`;
        if (buildError.stderr) logsRef.value += `Build command stderr:\n${buildError.stderr}\n`;
        if (buildError.stack) logsRef.value += `Build stack:\n${buildError.stack}\n`;
        throw buildError;
      }
    } else {
      logsRef.value += `Static site or no build needed. Uploading files from ${projectRootPath} to S3 at s3://${OLA_S3_BUCKET_NAME}/${s3ProjectBaseKey}...\n`;
      await uploadDirectoryRecursiveS3(projectRootPath, s3ProjectBaseKey, logsRef);
      logsRef.value += `Static files uploaded successfully to S3.\n`;
    }

    const deployedUrl = `/sites/${finalProjectName}`;
    logsRef.value += `Deployment successful. Access at: ${deployedUrl}\n`;
    console.log(`deployProject: Success. Returning result for project: ${finalProjectName}`);
    return {
      success: true,
      message: 'Project deployed successfully to S3-compatible storage!',
      projectName: finalProjectName,
      deployedUrl,
      logs: logsRef.value
    };

  } catch (error: any) {
    console.error('deployProject: Caught error in main try-catch block.', error);
    logsRef.value += `\n--- ERROR DETAILS ---\n`;
    
    let e_message = "An unknown error occurred during deployment.";
    let e_name = "UnknownError";

    if (error instanceof Error) {
        e_message = error.message;
        e_name = error.name;
        logsRef.value += `Error Name: ${error.name}\n`;
        logsRef.value += `Error Message: ${error.message}\n`;
        if (error.stack) {
             logsRef.value += `Stack Trace:\n${error.stack}\n`;
        }
    } else if (typeof error === 'string') {
        e_message = error;
        logsRef.value += `Error: ${error}\n`;
    } else if (error && typeof error === 'object' && 'message' in error) {
        e_message = String(error.message);
        if ('name' in error) e_name = String(error.name);
        logsRef.value += `Error Object: ${JSON.stringify(error)}\n`;
    } else {
        logsRef.value += `Unknown Error Type: ${JSON.stringify(error)}\n`;
    }

    let detailedErrorMessage = e_message;
    if (e_name !== "UnknownError" && e_name !== "" && !e_message.toLowerCase().includes(e_name.toLowerCase())) {
        detailedErrorMessage = `${e_name}: ${e_message}`;
    }
    
    if (error.$metadata && error.$metadata.httpStatusCode) {
        detailedErrorMessage += ` (S3 HTTP Status: ${error.$metadata.httpStatusCode})`;
        logsRef.value += `S3 HTTP Status Code: ${error.$metadata.httpStatusCode}\n`;
    }
    logsRef.value += `---------------------\n`;


    console.error('Detailed Deployment error (server console):', detailedErrorMessage, '\nFull error object (server console):', error);
    console.log(`deployProject: Error. Returning failure result for project: ${finalProjectName}`);
    
    // Truncate logs for the response to avoid overly large JSON payloads
    const logSnippetForResponse = logsRef.value.length > 2000 ? logsRef.value.substring(0, 1997) + "..." : logsRef.value;

    return {
        success: false,
        message: `Deployment failed. ${detailedErrorMessage}`, // This message goes to the UI
        logs: logSnippetForResponse, // Send a snippet to UI, full logs on server
        projectName: finalProjectName, 
    };
  } finally {
    console.log(`deployProject: Entered finally block for project: ${finalProjectName}. UniqueExtractionDir: ${uniqueExtractionDir}`);
    try {
      if (uniqueExtractionDir && uniqueExtractionDir.startsWith(TEMP_UPLOAD_DIR) && uniqueExtractionDir !== TEMP_UPLOAD_DIR) {
        logsRef.value += `Attempting to delete temporary directory: ${uniqueExtractionDir}\n`;
        console.log(`deployProject: Attempting to delete temporary directory: ${uniqueExtractionDir}`);
        await fs.rm(uniqueExtractionDir, { recursive: true, force: true });
        logsRef.value += `Successfully deleted temporary directory: ${uniqueExtractionDir}\n`;
        console.log(`deployProject: Successfully deleted temporary directory: ${uniqueExtractionDir}`);
      } else {
        if (uniqueExtractionDir) {
            const skipMessage = `Skipping deletion of non-specific or base temporary directory: ${uniqueExtractionDir}`;
            logsRef.value += `${skipMessage}\n`;
            console.warn(`deployProject: ${skipMessage}`);
        } else {
            const skipMessage = `Skipping cleanup: uniqueExtractionDir was not set (likely due to an early error).`;
            logsRef.value += `${skipMessage}\n`;
            console.log(`deployProject: ${skipMessage}`);
        }
      }
    } catch (cleanupError: any) {
      const cleanupErrorMessage = `Error during cleanup of ${uniqueExtractionDir || 'path_not_set'}: ${cleanupError.message}`;
      logsRef.value += `${cleanupErrorMessage}\n`;
      console.error(`deployProject: ${cleanupErrorMessage}`, cleanupError.stack);
    }
    console.log(`deployProject: Action finished for project: ${finalProjectName}.`);
  }
}

