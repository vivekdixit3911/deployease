
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
import { detectFramework } from '@/ai/flows/detect-framework';

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
  s3BaseKey: string, // e.g., "sites/my-project"
  logsRef: { value: string }
) {
  if (!OLA_S3_BUCKET_NAME) {
    logsRef.value += 'Error: OLA_S3_BUCKET_NAME is not configured.\n';
    throw new Error('OLA_S3_BUCKET_NAME is not configured.');
  }
  const currentS3Client = s3Client(); // Get S3 client instance

  const entries = await fs.readdir(localDirPath, { withFileTypes: true });
  for (const entry of entries) {
    const localEntryPath = path.join(localDirPath, entry.name);
    const cleanEntryName = entry.name.replace(/^\/+|\/+$/g, '');
    const s3ObjectKey = `${s3BaseKey}/${cleanEntryName}`.replace(/^\/+/, ''); // Ensure no leading slash

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
        // ACL: 'public-read', // Uncomment if objects should be public by default
      });
      await currentS3Client.send(command);
      logsRef.value += `Uploaded ${localEntryPath} to s3://${OLA_S3_BUCKET_NAME}/${s3ObjectKey} successfully.\n`;
    }
  }
}

// Helper function to sanitize names for URLs/paths
const sanitizeName = (name: string | undefined | null): string => {
  if (!name) return '';
  return name
    .trim()
    .replace(/\s+/g, '-')          // Replace spaces with hyphens
    .replace(/[^a-zA-Z0-9-]/g, '') // Remove non-alphanumeric chars except hyphens
    .replace(/-+/g, '-')           // Replace multiple hyphens with single
    .replace(/^-+|-+$/g, '')       // Trim leading/trailing hyphens
    .toLowerCase();
};


export async function deployProject(formData: FormData): Promise<DeploymentResult> {
  const file = formData.get('zipfile') as File | null;

  if (!file) {
    return { success: false, message: 'No file uploaded.' };
  }

  if (file.type !== 'application/zip' && file.type !== 'application/x-zip-compressed') {
     return { success: false, message: 'Invalid file type. Please upload a ZIP file.' };
  }

  let tempZipPath = '';
  let extractionPath = '';
  let detectedFramework = 'unknown';
  const minNameLength = 3; // Minimum acceptable length for a project name part.
  let finalProjectName = 'untitled-project'; // Default project name
  
  const logsRef = { value: '' };

  try {
    if (!OLA_S3_BUCKET_NAME) {
        logsRef.value += 'Error: S3 bucket name is not configured in environment variables.\n';
        throw new Error('S3 bucket name (OLA_S3_BUCKET_NAME) is not configured.');
    }
    s3Client(); // Initialize client early to catch config errors

    await ensureDirectoryExists(TEMP_UPLOAD_DIR);
    
    const uniqueId = `${Date.now()}-${Math.random().toString(36).substring(2, 9)}`;
    tempZipPath = path.join(TEMP_UPLOAD_DIR, `${uniqueId}-${file.name}`);
    extractionPath = path.join(TEMP_UPLOAD_DIR, uniqueId, 'extracted');
    await ensureDirectoryExists(extractionPath);

    logsRef.value += `Uploading file: ${file.name}\n`;
    const fileBuffer = Buffer.from(await file.arrayBuffer());
    await fs.writeFile(tempZipPath, fileBuffer);
    logsRef.value += `File saved to: ${tempZipPath}\n`;

    logsRef.value += `Extracting ZIP file to temporary local directory ${extractionPath}...\n`;
    const zip = await JSZip.loadAsync(fileBuffer);
    const fileNames: string[] = [];
    let packageJsonContent: string | null = null;

    for (const relativePathInZip in zip.files) {
      const zipEntry = zip.files[relativePathInZip];
      const localDestPath = path.join(extractionPath, relativePathInZip);
      if (zipEntry.dir) {
        await ensureDirectoryExists(localDestPath);
      } else {
        const content = await zipEntry.async('nodebuffer');
        await ensureDirectoryExists(path.dirname(localDestPath));
        await fs.writeFile(localDestPath, content);
        fileNames.push(relativePathInZip);
        if (relativePathInZip.endsWith('package.json') || relativePathInZip === 'package.json') {
           packageJsonContent = content.toString('utf-8');
        }
      }
    }
    logsRef.value += `ZIP extraction to ${extractionPath} complete. Files: ${fileNames.join(', ')}\n`;
    
    if (fileNames.length === 0) {
      return { success: false, message: 'The uploaded ZIP file is empty or invalid.', logs: logsRef.value };
    }

    // Determine Project Name
    logsRef.value += `Determining project name...\n`;
    let aiSuggestion = '';
    try {
      const nameSuggestionOutput = await suggestProjectName({ fileNames });
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
      // finalProjectName remains 'untitled-project'
      logsRef.value += `Both AI and file-based names are unsuitable. Using default name: ${finalProjectName}\n`;
    }
    
    logsRef.value += `Detecting framework...\n`;
    let frameworkInputContent = 'No package.json found.';
    if (packageJsonContent) {
        frameworkInputContent = packageJsonContent;
    } else {
        const indexHtmlPath = fileNames.find(name => name.endsWith('index.html') || name === 'index.html');
        if (indexHtmlPath) {
            const indexHtmlFullPath = path.join(extractionPath, indexHtmlPath);
            try {
                frameworkInputContent = await fs.readFile(indexHtmlFullPath, 'utf-8');
                 logsRef.value += `Using content of ${indexHtmlPath} for framework detection.\n`;
            } catch (readError) {
                logsRef.value += `Could not read ${indexHtmlPath}: ${(readError as Error).message}\n`;
            }
        }
    }

    try {
      const frameworkDetection = await detectFramework({ fileContents: frameworkInputContent });
      detectedFramework = frameworkDetection.framework;
      logsRef.value += `Detected framework: ${detectedFramework} (Confidence: ${frameworkDetection.confidence})\n`;
    } catch (aiError) {
      logsRef.value += `AI framework detection failed: ${(aiError as Error).message}. Assuming 'static'.\n`;
      detectedFramework = 'static';
    }

    const s3ProjectBaseKey = `sites/${finalProjectName}`; 

    if (detectedFramework === 'react') {
      logsRef.value += `React project detected. Starting build process in ${extractionPath}...\n`;
      try {
        logsRef.value += `Running 'npm install'...\n`;
        const installOutput = await execAsync('npm install', { cwd: extractionPath });
        logsRef.value += `npm install stdout: ${installOutput.stdout}\n`;
        if (installOutput.stderr) logsRef.value += `npm install stderr: ${installOutput.stderr}\n`;

        logsRef.value += `Running 'npm run build'...\n`;
        const buildOutput = await execAsync('npm run build', { cwd: extractionPath });
        logsRef.value += `npm run build stdout: ${buildOutput.stdout}\n`;
        if (buildOutput.stderr) logsRef.value += `npm run build stderr: ${buildOutput.stderr}\n`;

        const buildDirs = ['build', 'dist', 'out'];
        let buildSourcePath = '';
        for (const dir of buildDirs) {
          const potentialPath = path.join(extractionPath, dir);
          try {
            await fs.access(potentialPath);
             if ((await fs.stat(potentialPath)).isDirectory()) {
                buildSourcePath = potentialPath;
                break;
            }
          } catch { /* Directory does not exist */ }
        }

        if (!buildSourcePath) {
          logsRef.value += `Error: Build output directory (build/, dist/, or out/) not found in ${extractionPath} after 'npm run build'.\n`;
          throw new Error('Build output directory not found.');
        }
        
        logsRef.value += `Uploading build files from ${buildSourcePath} to S3 at s3://${OLA_S3_BUCKET_NAME}/${s3ProjectBaseKey}...\n`;
        await uploadDirectoryRecursiveS3(buildSourcePath, s3ProjectBaseKey, logsRef);
        logsRef.value += `Build files uploaded successfully to S3.\n`;

      } catch (buildError: any) {
        logsRef.value += `Build process failed: ${buildError.message}\n`;
        if (buildError.stdout) logsRef.value += `stdout: ${buildError.stdout}\n`;
        if (buildError.stderr) logsRef.value += `stderr: ${buildError.stderr}\n`;
        return { success: false, message: `Build process failed: ${buildError.message}`, logs: logsRef.value };
      }
    } else { // Static site
      logsRef.value += `Static site detected. Uploading files from ${extractionPath} to S3 at s3://${OLA_S3_BUCKET_NAME}/${s3ProjectBaseKey}...\n`;
      await uploadDirectoryRecursiveS3(extractionPath, s3ProjectBaseKey, logsRef);
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
    if (error.name) { 
        detailedErrorMessage = `S3 Storage Error (${error.name}): ${error.message}`;
    }
    if (error.$metadata && error.$metadata.httpStatusCode) {
        detailedErrorMessage += ` (HTTP Status: ${error.$metadata.httpStatusCode})`;
    }
    
    logsRef.value += `An error occurred: ${detailedErrorMessage}\nStack: ${error.stack || 'N/A'}\n`;
    console.error('Detailed Deployment error:', detailedErrorMessage, 'Full error object:', error);
    
    return { 
        success: false, 
        message: `Deployment failed. ${detailedErrorMessage}`,
        logs: logsRef.value 
    };
  } finally {
    if (tempZipPath) {
      fs.unlink(tempZipPath).catch(err => console.error(`Failed to delete temp zip: ${tempZipPath}`, err));
    }
    if (extractionPath && extractionPath.startsWith(TEMP_UPLOAD_DIR) && extractionPath !== TEMP_UPLOAD_DIR) {
        const dirToDelete = path.dirname(extractionPath); 
         if (dirToDelete && dirToDelete.startsWith(TEMP_UPLOAD_DIR) && dirToDelete !== TEMP_UPLOAD_DIR) {
             fs.rm(dirToDelete, { recursive: true, force: true })
                .catch(err => console.error(`Failed to delete temp extraction folder: ${dirToDelete}`, err));
        }
    }
  }
}

