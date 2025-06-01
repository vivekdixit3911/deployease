
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
import { suggestProjectName } from '@/ai/flows/suggest-project-name';
import { detectFramework, DetectFrameworkInput } from '@/ai/flows/detect-framework';

const execAsync = promisify(exec);

interface DeploymentResult {
  success: boolean;
  message: string;
  projectName?: string;
  framework?: string;
  deployedUrl?: string;
  logs?: string;
}

async function ensureDirectoryExists(dirPath: string) {
  try {
    await fs.mkdir(dirPath, { recursive: true });
  } catch (error) {
    console.error(`Failed to create directory ${dirPath}:`, error);
    throw error;
  }
}

async function uploadDirectoryRecursiveS3(
  localDirPath: string,
  s3BaseKey: string,
  logsRef: { value: string }
) {
  if (!OLA_S3_BUCKET_NAME) {
    logsRef.value += 'Error: OLA_S3_BUCKET_NAME is not configured.\n';
    throw new Error('OLA_S3_BUCKET_NAME is not configured.');
  }
  const currentS3Client = s3Client(); // Ensures client is initialized and config is checked

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
  if (!name) return '';
  return name
    .trim()
    .replace(/\s+/g, '-')
    .replace(/[^a-zA-Z0-9-]/g, '')
    .replace(/-+/g, '-')
    .replace(/^-+|-+$/g, '')
    .toLowerCase();
};


export async function deployProject(formData: FormData): Promise<DeploymentResult> {
  const file = formData.get('zipfile') as File | null;
  const logsRef = { value: '' };

  if (!file) {
    return { success: false, message: 'No file uploaded.' };
  }

  if (file.type !== 'application/zip' && file.type !== 'application/x-zip-compressed') {
     return { success: false, message: 'Invalid file type. Please upload a ZIP file.' };
  }

  let tempZipPath = '';
  let extractionPath = ''; // Root directory where ZIP contents are extracted (e.g., .../uniqueId/extracted)
  let projectRootPath = ''; // Actual root of the project within extractionPath (e.g., extractionPath or extractionPath/subdir)
  let detectedFramework = 'unknown';
  const minNameLength = 3;
  let finalProjectName = 'untitled-project';
  
  try {
    if (!OLA_S3_BUCKET_NAME) {
        logsRef.value += 'Error: S3 bucket name (OLA_S3_BUCKET_NAME) is not configured in environment variables.\n';
        throw new Error('S3 bucket name (OLA_S3_BUCKET_NAME) is not configured.');
    }
    s3Client(); // Initialize client early to catch config errors

    await ensureDirectoryExists(TEMP_UPLOAD_DIR);
    
    const uniqueId = `${Date.now()}-${Math.random().toString(36).substring(2, 9)}`;
    const uniqueExtractionDir = path.join(TEMP_UPLOAD_DIR, uniqueId); // Parent for zip and extracted content
    tempZipPath = path.join(uniqueExtractionDir, file.name); // Keep zip inside unique folder for easier cleanup
    extractionPath = path.join(uniqueExtractionDir, 'extracted'); // All extracted files go here
    await ensureDirectoryExists(extractionPath);
    logsRef.value += `Root extraction path: ${extractionPath}\n`;

    logsRef.value += `Processing uploaded file: ${file.name}\n`;
    const fileBuffer = Buffer.from(await file.arrayBuffer());
    await fs.writeFile(tempZipPath, fileBuffer);
    logsRef.value += `Temporary ZIP file saved to: ${tempZipPath}\n`;

    const zip = await JSZip.loadAsync(fileBuffer);
    const fileNamesInZip: string[] = [];
    let projectPackageJsonRelativePath: string | null = null;
    let projectPackageJsonContent: string | null = null;
    const allPackageJsonPathsInZip: string[] = [];

    for (const relativePathInZip in zip.files) {
        fileNamesInZip.push(relativePathInZip);
        if (!zip.files[relativePathInZip].dir && path.basename(relativePathInZip).toLowerCase() === 'package.json') {
            allPackageJsonPathsInZip.push(relativePathInZip);
        }
    }
    logsRef.value += `Found ${allPackageJsonPathsInZip.length} package.json file(s) in ZIP at: ${allPackageJsonPathsInZip.join(', ') || 'None'}\n`;

    if (allPackageJsonPathsInZip.length > 0) {
      allPackageJsonPathsInZip.sort((a, b) => a.split('/').length - b.split('/').length);
      projectPackageJsonRelativePath = allPackageJsonPathsInZip[0];
      logsRef.value += `Selected package.json for analysis: ${projectPackageJsonRelativePath}\n`;
      try {
        const content = await zip.file(projectPackageJsonRelativePath)!.async('nodebuffer');
        projectPackageJsonContent = content.toString('utf-8');
      } catch (e) {
        logsRef.value += `Error reading content of selected package.json (${projectPackageJsonRelativePath}): ${(e as Error).message}\n`;
        projectPackageJsonContent = null;
      }
    }

    projectRootPath = extractionPath; 
    if (projectPackageJsonRelativePath) {
      projectRootPath = path.join(extractionPath, path.dirname(projectPackageJsonRelativePath));
    }
    logsRef.value += `Initial project root path (based on package.json or extraction root): ${projectRootPath}\n`;
    
    logsRef.value += `Extracting all ZIP files to ${extractionPath}...\n`;
    for (const relativePathInZip in zip.files) {
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

    logsRef.value += `Determining project name...\n`;
    let aiSuggestion = '';
    try {
      const nameSuggestionOutput = await suggestProjectName({ fileNames: fileNamesInZip });
      aiSuggestion = sanitizeName(nameSuggestionOutput.projectName);
      logsRef.value += `AI suggested name (raw: "${nameSuggestionOutput.projectName}", sanitized: "${aiSuggestion}")\n`;
    } catch (error) {
      logsRef.value += `AI project name suggestion failed: ${(error as Error).message}\n`;
    }

    const uploadedFileNameWithoutExtension = file.name.replace(/\.zip$/i, '');
    const fileBasedName = sanitizeName(uploadedFileNameWithoutExtension);
    logsRef.value += `Uploaded file name (raw: "${file.name}", base: "${uploadedFileNameWithoutExtension}", sanitized: "${fileBasedName}")\n`;

    if (aiSuggestion && aiSuggestion !== 'untitled-project' && aiSuggestion.length >= minNameLength) {
      finalProjectName = aiSuggestion;
      logsRef.value += `Using AI suggested name: ${finalProjectName}\n`;
    } else if (fileBasedName && fileBasedName.length >= minNameLength) {
      finalProjectName = fileBasedName;
      logsRef.value += `AI name unsuitable or unavailable. Using file-based name: ${finalProjectName}\n`;
    } else {
      // finalProjectName is already 'untitled-project' by default
      logsRef.value += `Both AI and file-based names are unsuitable or too short. Using default name: ${finalProjectName}\n`;
    }
    
    logsRef.value += `Detecting framework...\n`;
    let frameworkInput: DetectFrameworkInput = { fileContents: 'No package.json or index.html found for analysis.', fileNameAnalyzed: 'unknown' };

    if (projectPackageJsonContent) {
        frameworkInput = { fileContents: projectPackageJsonContent, fileNameAnalyzed: projectPackageJsonRelativePath! };
        logsRef.value += `Framework detection input: content of '${projectPackageJsonRelativePath}'.\n`;
    } else {
        const findIndexHtmlRecursive = async (currentDir: string): Promise<string | null> => {
            const entries = await fs.readdir(currentDir, { withFileTypes: true });
            entries.sort((a, b) => (a.isDirectory() ? 1 : -1) - (b.isDirectory() ? 1 : -1)); 

            for (const entry of entries) {
                const entryPath = path.join(currentDir, entry.name);
                if (entry.isFile() && entry.name.toLowerCase() === 'index.html') {
                    return entryPath;
                }
            }
            for (const entry of entries) {
                 if (entry.isDirectory()) {
                    const foundInSubDir = await findIndexHtmlRecursive(path.join(currentDir, entry.name));
                    if (foundInSubDir) return foundInSubDir;
                }
            }
            return null;
        };
        
        const foundIndexHtmlFullPath = await findIndexHtmlRecursive(extractionPath);

        if (foundIndexHtmlFullPath) {
            try {
                const indexHtmlContent = await fs.readFile(foundIndexHtmlFullPath, 'utf-8');
                const relativeIndexPath = path.relative(extractionPath, foundIndexHtmlFullPath);
                frameworkInput = { fileContents: indexHtmlContent, fileNameAnalyzed: relativeIndexPath };
                logsRef.value += `Framework detection input: content of '${relativeIndexPath}'.\n`;
                projectRootPath = path.dirname(foundIndexHtmlFullPath); // Adjust project root for static site if index.html is used
                logsRef.value += `Adjusted project root for static site based on index.html (${relativeIndexPath}) to: ${projectRootPath}\n`;
            } catch (readError) {
                logsRef.value += `Could not read found index.html at ${foundIndexHtmlFullPath}: ${(readError as Error).message}\n`;
                 frameworkInput = { fileContents: `Error reading index.html: ${(readError as Error).message}`, fileNameAnalyzed: 'index.html_read_error' };
            }
        } else {
            logsRef.value += `No suitable package.json or index.html found for framework detection.\n`;
            frameworkInput = { fileContents: `No primary analysis files (package.json, index.html) found in ZIP. Analyzed files: ${fileNamesInZip.join(', ')}`, fileNameAnalyzed: 'none_found' };
        }
    }
    
    logsRef.value += `Content for framework detection (first 500 chars of ${frameworkInput.fileNameAnalyzed}):\n---\n${frameworkInput.fileContents.substring(0, 500)}${frameworkInput.fileContents.length > 500 ? '...' : ''}\n---\n`;

    try {
      const frameworkDetection = await detectFramework(frameworkInput);
      detectedFramework = frameworkDetection.framework;
      logsRef.value += `AI Detected framework: ${detectedFramework} (Confidence: ${frameworkDetection.confidence})\n`;
    } catch (aiError: any) {
      logsRef.value += `AI framework detection failed: ${(aiError as Error).message}. Stack: ${aiError.stack}. Assuming 'static' due to error.\n`;
      detectedFramework = 'static';
    }

    const s3ProjectBaseKey = `sites/${finalProjectName}`; 
    logsRef.value += `Final detected framework for build process: ${detectedFramework}\n`;
    logsRef.value += `Project root path for build/upload: ${projectRootPath}\n`;

    if (detectedFramework === 'react') {
      logsRef.value += `React project detected. Starting build process in ${projectRootPath}...\n`;
      try {
        logsRef.value += `Running 'npm install' in ${projectRootPath}...\n`;
        const installOutput = await execAsync('npm install', { cwd: projectRootPath });
        logsRef.value += `npm install stdout:\n${installOutput.stdout || 'N/A'}\n`;
        if (installOutput.stderr) logsRef.value += `npm install stderr:\n${installOutput.stderr}\n`;

        logsRef.value += `Running 'npm run build' in ${projectRootPath}...\n`;
        const buildOutput = await execAsync('npm run build', { cwd: projectRootPath });
        logsRef.value += `npm run build stdout:\n${buildOutput.stdout || 'N/A'}\n`;
        if (buildOutput.stderr) logsRef.value += `npm run build stderr:\n${buildOutput.stderr}\n`;

        const buildDirs = ['build', 'dist', 'out'];
        let buildSourcePath = ''; 
        for (const dir of buildDirs) {
          const potentialPath = path.join(projectRootPath, dir);
          try {
            await fs.access(potentialPath); // Check if path exists
             if ((await fs.stat(potentialPath)).isDirectory()) { // Check if it's a directory
                buildSourcePath = potentialPath;
                logsRef.value += `Found build output directory at: ${buildSourcePath}\n`;
                break;
            }
          } catch { /* Directory does not exist or not accessible */ }
        }

        if (!buildSourcePath) {
          logsRef.value += `Error: Build output directory (build/, dist/, or out/) not found in ${projectRootPath} after 'npm run build'. Listing directory contents of ${projectRootPath}:\n`;
          try {
            const rootContents = await fs.readdir(projectRootPath, {withFileTypes: true});
            logsRef.value += rootContents.map(entry => `${entry.name}${entry.isDirectory() ? '/' : ''}`).join(', ') + '\n';
          } catch(e) { logsRef.value += `Could not list contents of ${projectRootPath}: ${(e as Error).message}\nStack: ${(e as Error).stack}\n`; }
          throw new Error('Build output directory not found. Check build scripts and output configuration.');
        }
        
        logsRef.value += `Uploading React build files from ${buildSourcePath} to S3 at s3://${OLA_S3_BUCKET_NAME}/${s3ProjectBaseKey}...\n`;
        await uploadDirectoryRecursiveS3(buildSourcePath, s3ProjectBaseKey, logsRef);
        logsRef.value += `React build files uploaded successfully to S3.\n`;

      } catch (buildError: any) {
        logsRef.value += `React build process failed: ${buildError.message}\n`;
        if (buildError.stdout) logsRef.value += `Build stdout:\n${buildError.stdout}\n`;
        if (buildError.stderr) logsRef.value += `Build stderr:\n${buildError.stderr}\n`;
        if (buildError.stack) logsRef.value += `Build stack:\n${buildError.stack}\n`;
        return { success: false, message: `React build process failed: ${buildError.message}`, logs: logsRef.value, projectName: finalProjectName, framework: detectedFramework };
      }
    } else { // Static site
      logsRef.value += `Static site detected. Uploading files from ${projectRootPath} to S3 at s3://${OLA_S3_BUCKET_NAME}/${s3ProjectBaseKey}...\n`;
      await uploadDirectoryRecursiveS3(projectRootPath, s3ProjectBaseKey, logsRef);
      logsRef.value += `Static files uploaded successfully to S3.\n`;
    }

    const deployedUrl = `/sites/${finalProjectName}`; 
    logsRef.value += `Deployment successful. Access at: ${deployedUrl}\n`;

    return {
      success: true,
      message: 'Project deployed successfully to S3-compatible storage!',
      projectName: finalProjectName,
      framework: detectedFramework,
      deployedUrl,
      logs: logsRef.value
    };

  } catch (error: any) {
    let detailedErrorMessage = error.message;
    if (error.name && error.message && !error.message.toLowerCase().includes(error.name.toLowerCase())) { 
        detailedErrorMessage = `${error.name}: ${error.message}`;
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
        framework: detectedFramework
    };
  } finally {
    // Cleanup the unique extraction directory which contains the temp zip and extracted files
    if (extractionPath) { // If extractionPath was set, uniqueExtractionDir was also set
      const uniqueExtractionDirToDelete = path.dirname(extractionPath); // This should be TEMP_UPLOAD_DIR/uniqueId
      if (uniqueExtractionDirToDelete && uniqueExtractionDirToDelete.startsWith(TEMP_UPLOAD_DIR) && uniqueExtractionDirToDelete !== TEMP_UPLOAD_DIR) {
        logsRef.value += `Attempting to delete temporary directory: ${uniqueExtractionDirToDelete}\n`;
        fs.rm(uniqueExtractionDirToDelete, { recursive: true, force: true })
          .then(() => logsRef.value += `Successfully deleted temporary directory: ${uniqueExtractionDirToDelete}\n`)
          .catch(err => {
            logsRef.value += `Failed to delete temp extraction base folder: ${uniqueExtractionDirToDelete}. Error: ${err.message}\n`;
            console.error(`Failed to delete temp extraction base folder: ${uniqueExtractionDirToDelete}`, err);
          });
      } else {
          logsRef.value += `Skipping deletion of non-specific temporary directory: ${uniqueExtractionDirToDelete}\n`;
      }
    } else if (tempZipPath) { // Fallback if only tempZipPath was created (e.g., error before extraction)
        logsRef.value += `Attempting to delete temporary zip file: ${tempZipPath}\n`;
        fs.unlink(tempZipPath)
          .then(() => logsRef.value += `Successfully deleted temporary zip file: ${tempZipPath}\n`)
          .catch(err => {
            logsRef.value += `Failed to delete temp zip: ${tempZipPath}. Error: ${err.message}\n`;
            console.error(`Failed to delete temp zip: ${tempZipPath}`, err);
          });
    }
  }
}

