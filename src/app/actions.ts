
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
  // framework info is no longer shown in UI
  // framework?: FrameworkDetectionResult['framework'];
  // build_command?: string;
  // output_directory?: string;
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
    // Ensure s3ObjectKey correctly joins parts and cleans up potential double slashes
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
    .replace(/\.zip$/i, '') // Remove .zip extension
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

      // Higher specificity frameworks first
      if (dependencies.next) {
        logsRef.value += "Detected Next.js.\n";
        const buildScript = scripts.build || 'next build';
        return { framework: 'nextjs', build_command: buildScript, output_directory: '.next', reasoning: "Next.js dependency found." };
      }
      if (dependencies['@remix-run/dev'] || dependencies.remix) {
        logsRef.value += "Detected Remix.\n";
        const buildScript = scripts.build || 'remix build';
        return { framework: 'remix', build_command: buildScript, output_directory: 'public/build', reasoning: "Remix dependency found." };
      }
       if (dependencies['@sveltejs/kit']) {
        logsRef.value += "Detected SvelteKit.\n";
        const buildScript = scripts.build || 'vite build'; // SvelteKit often uses vite
        return { framework: 'sveltekit', build_command: buildScript, output_directory: 'build', reasoning: "SvelteKit dependency found." };
      }
      if (dependencies.nuxt) {
        logsRef.value += "Detected Nuxt.js.\n";
        const buildScript = scripts.build || 'nuxt build';
        return { framework: 'nuxtjs', build_command: buildScript, output_directory: '.output/public', reasoning: "Nuxt.js dependency found." };
      }
      if (dependencies.astro) {
        logsRef.value += "Detected Astro.\n";
        const buildScript = scripts.build || 'astro build';
        return { framework: 'astro', build_command: buildScript, output_directory: 'dist', reasoning: "Astro dependency found." };
      }
      // General Vite with React (check after more specific Vite-based frameworks like SvelteKit)
      if (dependencies.vite && (dependencies['@vitejs/plugin-react'] || dependencies['@vitejs/plugin-react-swc'])) {
        logsRef.value += "Detected Vite with React.\n";
        const buildScript = scripts.build || 'vite build';
        return { framework: 'vite-react', build_command: buildScript, output_directory: 'dist', reasoning: "Vite with React plugin detected." };
      }
      if (dependencies['react-scripts']) {
        logsRef.value += "Detected Create React App.\n";
        const buildScript = scripts.build || 'npm run build'; 
        return { framework: 'cra', build_command: buildScript, output_directory: 'build', reasoning: "Create React App (react-scripts) dependency found." };
      }
      // Generic React (if not caught by CRA or Vite+React)
      if (dependencies.react && dependencies['react-dom']) {
        logsRef.value += "Detected Generic React project.\n";
        const buildScript = scripts.build || 'npm run build'; 
        return { framework: 'generic-react', build_command: buildScript, output_directory: 'dist', reasoning: "Generic React (react and react-dom) dependencies found." };
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
  const file = formData.get('zipfile') as File | null;
  let logsRef = { value: '' };

  if (!file) {
    return { success: false, message: 'No file uploaded.' };
  }

  if (file.type !== 'application/zip' && file.type !== 'application/x-zip-compressed') {
     return { success: false, message: 'Invalid file type. Please upload a ZIP file.' };
  }

  let tempZipPath = '';
  let extractionPath = ''; 
  let projectRootPath = ''; 
  let frameworkDetectionResult: FrameworkDetectionResult = { 
    framework: 'static', 
    reasoning: "Initial value",
  };
  const minNameLength = 3;
  let finalProjectName = 'untitled-project';
  
  try {
    if (!OLA_S3_BUCKET_NAME) {
        logsRef.value += 'Error: S3 bucket name (OLA_S3_BUCKET_NAME) is not configured in environment variables.\n';
        throw new Error('S3 bucket name (OLA_S3_BUCKET_NAME) is not configured.');
    }
    s3Client(); 
    logsRef.value += 'S3 client initialized and configuration seems present.\n';

    await ensureDirectoryExists(TEMP_UPLOAD_DIR); 
    logsRef.value += `Base temporary upload directory ensured: ${TEMP_UPLOAD_DIR}\n`;
    
    const uniqueId = `${Date.now()}-${Math.random().toString(36).substring(2, 9)}`;
    const uniqueExtractionDir = path.join(TEMP_UPLOAD_DIR, uniqueId); 
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
      return { success: false, message: 'The uploaded ZIP file is empty or invalid.', logs: logsRef.value };
    }

    logsRef.value += `Determining project name from filename...\n`;
    const fileBasedName = sanitizeName(file.name);
    logsRef.value += `Uploaded file name (raw: "${file.name}", sanitized: "${fileBasedName}")\n`;

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
        logsRef.value += `Content for framework detection (first 500 chars of ${analysisFileRelativePath}):\n---\n${analysisFileContent.substring(0, 500)}${analysisFileContent.length > 500 ? '...' : ''}\n---\n`;
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
        logsRef.value += `Running 'npm install' in ${projectRootPath}...\n`;
        const installOutput = await execAsync('npm install', { cwd: projectRootPath });
        logsRef.value += `npm install stdout:\n${installOutput.stdout || 'N/A'}\n`;
        if (installOutput.stderr) logsRef.value += `npm install stderr:\n${installOutput.stderr}\n`;

        let buildCommandToExecute = frameworkDetectionResult.build_command;
        const buildEnv = { ...process.env };
        const publicUrlForAssets = `/sites/${finalProjectName}`;

        if (['cra', 'generic-react'].includes(frameworkDetectionResult.framework)) {
            buildEnv.PUBLIC_URL = publicUrlForAssets;
            logsRef.value += `Setting PUBLIC_URL=${publicUrlForAssets} for build.\n`;
        } else if (frameworkDetectionResult.framework === 'vite-react') {
            // Ensure the base path ends with a slash for Vite
            const viteBasePath = publicUrlForAssets.endsWith('/') ? publicUrlForAssets : `${publicUrlForAssets}/`;
            buildCommandToExecute = `${buildCommandToExecute} --base=${viteBasePath}`;
            logsRef.value += `Appending --base=${viteBasePath} to Vite build command.\n`;
        }
        // For Next.js, ASSET_PREFIX could be used, but basePath in next.config.js is more robust.
        // For this generic solution, we'll rely on PUBLIC_URL for frameworks that support it.
        // Users of Next.js might need to pre-configure basePath in their next.config.js if deploying to a subpath.
        
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
          const defaultOutputDirs = ['build', 'dist', 'out', '.next', '.output/public', 'public/build'];
          for (const dir of defaultOutputDirs) {
            if (detectedOutputDir === dir && buildSourcePath) continue; 
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
        return { 
            success: false, 
            message: `Build process failed: ${buildError.message}`, 
            logs: logsRef.value, 
            projectName: finalProjectName
        };
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
    console.error('Detailed Deployment error:', detailedErrorMessage, 'Full error object:', error);
    
    return { 
        success: false, 
        message: `Deployment failed. ${detailedErrorMessage}`,
        logs: logsRef.value,
        projectName: finalProjectName, 
    };
  } finally {
    if (extractionPath) { 
      const uniqueExtractionDirToDelete = path.dirname(tempZipPath); 
      if (uniqueExtractionDirToDelete && uniqueExtractionDirToDelete.startsWith(TEMP_UPLOAD_DIR) && uniqueExtractionDirToDelete !== TEMP_UPLOAD_DIR) {
        logsRef.value += `Attempting to delete temporary directory: ${uniqueExtractionDirToDelete}\n`;
        fs.rm(uniqueExtractionDirToDelete, { recursive: true, force: true })
          .then(() => {
            logsRef.value += `Successfully deleted temporary directory: ${uniqueExtractionDirToDelete}\n`;
            console.log(`Successfully deleted temporary directory: ${uniqueExtractionDirToDelete}`);
          })
          .catch(err => {
            logsRef.value += `Failed to delete temp extraction base folder: ${uniqueExtractionDirToDelete}. Error: ${(err as Error).message}\n`;
            console.error(`Failed to delete temp extraction base folder: ${uniqueExtractionDirToDelete}`, err);
          });
      } else {
          logsRef.value += `Skipping deletion of non-specific or base temporary directory: ${uniqueExtractionDirToDelete}\n`;
          console.warn(`Skipping deletion of non-specific or base temporary directory: ${uniqueExtractionDirToDelete}`);
      }
    }
  }
}

    