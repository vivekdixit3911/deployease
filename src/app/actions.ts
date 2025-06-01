
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
        return { framework: 'sveltekit', build_command: scripts.build || 'vite build', output_directory: '.svelte-kit/output/client', reasoning: "SvelteKit dependency found." };
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
        logsRef.value += "Detected Generic React project.\n";
        return { framework: 'generic-react', build_command: scripts.build || 'npm run build', output_directory: 'dist', reasoning: "Generic React (react and react-dom) dependencies found." };
      }


      logsRef.value += "package.json found, but no clear common framework indicators. Assuming static or custom Node.js build.\n";
      if (scripts.build) {
        return { framework: 'custom-build', build_command: scripts.build, output_directory: 'dist', reasoning: "package.json with a build script, but unrecognized framework. Assuming 'dist' output." };
      }
      return { framework: 'static', reasoning: "package.json present but no specific framework indicators or standard build script found." };
    } catch (e) {
      logsRef.value += `Error parsing package.json: ${(e as Error).message}. Assuming static.\n`;
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
  let logsRef = { value: '' };
  let tempZipPath = ''; // Will be set inside try
  let extractionPath = ''; // Will be set inside try, this refers to the /extracted subdir
  let projectRootPath = ''; // Will be set inside try
  let finalProjectName = 'untitled-project'; // Default, can be overridden
  let frameworkDetectionResult: FrameworkDetectionResult = {
    framework: 'static',
    reasoning: "Initial value before analysis",
  };
  let uniqueExtractionDir: string | null = null; // To store the path like /tmp/project_uploads/uniqueId

  try {
    // S3 client initialization and configuration checks
    if (!OLA_S3_BUCKET_NAME) {
        logsRef.value += 'Error: S3 bucket name (OLA_S3_BUCKET_NAME) is not configured in environment variables.\n';
        throw new Error('S3 bucket name (OLA_S3_BUCKET_NAME) is not configured.');
    }
    s3Client(); // Initialize client early to catch config errors. Throws on critical config error.
    logsRef.value += 'S3 client initialized and configuration seems present.\n';

    // File handling moved inside try
    const file = formData.get('zipfile') as File | null;

    if (!file) {
      // This will be caught by the main catch block and returned as DeploymentResult
      // No, this will return directly. Let's throw to be caught by main catch.
      logsRef.value += 'No file uploaded by the user.\n';
      throw new Error('No file uploaded.');
    }

    if (file.type !== 'application/zip' && file.type !== 'application/x-zip-compressed') {
      logsRef.value += `Invalid file type received: ${file.type}. Please upload a ZIP file.\n`;
      throw new Error('Invalid file type. Please upload a ZIP file.');
    }

    // Temporary directory setup
    await ensureDirectoryExists(TEMP_UPLOAD_DIR); // This can throw
    logsRef.value += `Base temporary upload directory ensured: ${TEMP_UPLOAD_DIR}\n`;

    const uniqueId = `${Date.now()}-${Math.random().toString(36).substring(2, 9)}`;
    uniqueExtractionDir = path.join(TEMP_UPLOAD_DIR, uniqueId); // Store this for cleanup
    tempZipPath = path.join(uniqueExtractionDir, file.name);
    extractionPath = path.join(uniqueExtractionDir, 'extracted'); // This is <uniqueExtractionDir>/extracted
    
    await ensureDirectoryExists(uniqueExtractionDir); // This can throw
    await ensureDirectoryExists(extractionPath); // This can throw
    logsRef.value += `Root extraction path for this deployment: ${extractionPath}\n`;

    logsRef.value += `Processing uploaded file: ${file.name}\n`;
    const fileBuffer = Buffer.from(await file.arrayBuffer()); // This can throw
    await fs.writeFile(tempZipPath, fileBuffer); // This can throw
    logsRef.value += `Temporary ZIP file saved to: ${tempZipPath}\n`;

    const zip = await JSZip.loadAsync(fileBuffer); // This can throw
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
      projectRootPath = baseExtractionPath; // Default to root of extracted files if no suitable file found
      return { filePath: null, content: null, relativePath: null };
    };

    const analysisResult = await findAnalysisFile(extractionPath, extractionPath);
    analysisFileRelativePath = analysisResult.relativePath;
    analysisFileContent = analysisResult.content;

    if (analysisFileRelativePath && analysisFileContent) {
        logsRef.value += `Framework detection input: content of '${analysisFileRelativePath}'. Project root set to: ${projectRootPath}\n`;
        frameworkDetectionResult = nonAIDetectFramework(analysisFileContent, analysisFileRelativePath, logsRef);
    } else {
        projectRootPath = extractionPath; // Ensure projectRootPath is the base extraction path if no specific file led to a sub-directory
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
        // PUBLIC_URL should NOT have a trailing slash for CRA like frameworks
        // Vite's --base expects a trailing slash if it's a path
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
            // For these frameworks, users often set basePath/assetPrefix in their respective config files.
            // Setting PUBLIC_URL might offer some compatibility for tools used by these frameworks, but isn't the primary mechanism.
            buildEnv.PUBLIC_URL = publicUrlForAssets;
            logsRef.value += `Setting PUBLIC_URL=${publicUrlForAssets} for ${frameworkDetectionResult.framework} build (for potential asset prefixing if framework uses it).\n`;
             if (frameworkDetectionResult.framework === 'nextjs') {
                // Next.js might require assetPrefix in next.config.js for this to fully work.
                // We are not modifying user's config files here.
                logsRef.value += `Note for Next.js: For proper asset prefixing, ensure 'assetPrefix' is set in next.config.js if deploying to a subpath.\n`;
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
            if (detectedOutputDir === dir && buildSourcePath) continue; // Already checked or found
            const potentialPath = path.join(projectRootPath, dir);
            try {
              await fs.access(potentialPath);
               if ((await fs.stat(potentialPath)).isDirectory()) {
                  buildSourcePath = potentialPath;
                  logsRef.value += `Found build output directory (fallback search) at: ${buildSourcePath}\n`;
                  frameworkDetectionResult.output_directory = dir; // Update if found via fallback
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
          } catch(e: any) { logsRef.value += `Could not list contents of ${projectRootPath}: ${(e as Error).message}\nStack: ${(e as Error).stack}\n`; }
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
        throw buildError; // Rethrow to be caught by the main try-catch, which will form the DeploymentResult
      }
    } else {
      logsRef.value += `Static site or no build needed. Uploading files from ${projectRootPath} to S3 at s3://${OLA_S3_BUCKET_NAME}/${s3ProjectBaseKey}...\n`;
      await uploadDirectoryRecursiveS3(projectRootPath, s3ProjectBaseKey, logsRef);
      logsRef.value += `Static files uploaded successfully to S3.\n`;
    }

    const deployedUrl = `/sites/${finalProjectName}`;
    logsRef.value += `Deployment successful. Access at: ${deployedUrl}\n`;

    return {
      success: true,
      message: 'Project deployed successfully to S3-compatible storage!',
      projectName: finalProjectName,
      deployedUrl,
      logs: logsRef.value
    };

  } catch (error: any) {
    let detailedErrorMessage = error.message || "An unknown error occurred.";
    if (error.name && error.message && !error.message.toLowerCase().includes(error.name.toLowerCase())) {
        detailedErrorMessage = `${error.name}: ${error.message}`;
    } else if (error.name && !error.message) {
        detailedErrorMessage = error.name;
    }

    if (error.$metadata && error.$metadata.httpStatusCode) {
        detailedErrorMessage += ` (S3 HTTP Status: ${error.$metadata.httpStatusCode})`;
    }

    logsRef.value += `An error occurred: ${detailedErrorMessage}\nStack: ${error.stack || 'N/A'}\n`;
    console.error('Detailed Deployment error:', detailedErrorMessage, '\nFull error object:', error);

    return {
        success: false,
        message: `Deployment failed. ${detailedErrorMessage}`,
        logs: logsRef.value,
        projectName: finalProjectName, 
    };
  } finally {
    try {
      // Use uniqueExtractionDir which is /tmp/project_uploads/uniqueId
      if (uniqueExtractionDir && uniqueExtractionDir.startsWith(TEMP_UPLOAD_DIR) && uniqueExtractionDir !== TEMP_UPLOAD_DIR) {
        logsRef.value += `Attempting to delete temporary directory: ${uniqueExtractionDir}\n`;
        await fs.rm(uniqueExtractionDir, { recursive: true, force: true });
        logsRef.value += `Successfully deleted temporary directory: ${uniqueExtractionDir}\n`;
        console.log(`Successfully deleted temporary directory: ${uniqueExtractionDir}`);
      } else {
        if (uniqueExtractionDir) { // Only log if it was set but didn't meet criteria
            logsRef.value += `Skipping deletion of non-specific or base temporary directory: ${uniqueExtractionDir}\n`;
            console.warn(`Skipping deletion of non-specific or base temporary directory: ${uniqueExtractionDir}`);
        } else {
            logsRef.value += `Skipping cleanup: uniqueExtractionDir was not set (likely due to an early error).\n`;
        }
      }
    } catch (cleanupError: any) {
      logsRef.value += `Error during cleanup of ${uniqueExtractionDir || 'path_not_set'}: ${cleanupError.message}\n`;
      console.error(`Error during cleanup of ${uniqueExtractionDir || 'path_not_set'}:`, cleanupError);
      // Do not rethrow from finally as it might mask the original error.
    }
  }
}
