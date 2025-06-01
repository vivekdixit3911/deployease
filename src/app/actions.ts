
// src/app/actions.ts
'use server';

import fs from 'fs/promises';
import path from 'path';
import { exec } from 'child_process';
import { promisify } from 'util';
import JSZip from 'jszip';
import { TEMP_UPLOAD_DIR } from '@/config/constants'; // SITES_DIR is no longer used here
import { suggestProjectName } from '@/ai/flows/suggest-project-name';
import { detectFramework } from '@/ai/flows/detect-framework';
import { storage as firebaseStorage } from '@/lib/firebase'; // Firebase storage instance
import { ref as firebaseStorageRef, uploadBytes } from 'firebase/storage'; // Removed uploadString as it's not used

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

// Helper function to recursively upload a directory to Firebase Storage
async function uploadDirectoryRecursive(
  fbStorage: typeof firebaseStorage, // Explicit type
  localDirPath: string,
  storageDirPath: string,
  logsRef: { value: string }
) {
  const entries = await fs.readdir(localDirPath, { withFileTypes: true });
  for (const entry of entries) {
    const localEntryPath = path.join(localDirPath, entry.name);
    // Ensure storageEntryPath doesn't have leading/trailing slashes issues from entry.name
    const cleanEntryName = entry.name.replace(/^\/+|\/+$/g, '');
    const storageEntryPath = `${storageDirPath}/${cleanEntryName}`;
    
    if (entry.isDirectory()) {
      await uploadDirectoryRecursive(fbStorage, localEntryPath, storageEntryPath, logsRef);
    } else {
      logsRef.value += `Uploading ${localEntryPath} to ${storageEntryPath}...\n`;
      const fileBuffer = await fs.readFile(localEntryPath);
      const fileRef = firebaseStorageRef(fbStorage, storageEntryPath);
      await uploadBytes(fileRef, fileBuffer);
      logsRef.value += `Uploaded ${localEntryPath} to ${storageEntryPath} successfully.\n`;
    }
  }
}


export async function deployProject(formData: FormData): Promise<DeploymentResult> {
  const file = formData.get('zipfile') as File | null;

  if (!file) {
    return { success: false, message: 'No file uploaded.' };
  }

  if (file.type !== 'application/zip' && file.type !== 'application/x-zip-compressed') {
     return { success: false, message: 'Invalid file type. Please upload a ZIP file.' };
  }

  let tempZipPath = '';
  let extractionPath = ''; // Temp local extraction path
  let finalProjectName = 'untitled-project';
  let detectedFramework = 'unknown';
  
  const logsRef = { value: '' }; // Pass by reference for helper

  try {
    await ensureDirectoryExists(TEMP_UPLOAD_DIR);
    
    const uniqueId = `${Date.now()}-${Math.random().toString(36).substring(2, 9)}`;
    tempZipPath = path.join(TEMP_UPLOAD_DIR, `${uniqueId}-${file.name}`);
    extractionPath = path.join(TEMP_UPLOAD_DIR, uniqueId, 'extracted'); // This is where files are extracted locally
    await ensureDirectoryExists(extractionPath);

    logsRef.value += `Uploading file: ${file.name}\n`;
    const fileBuffer = Buffer.from(await file.arrayBuffer());
    await fs.writeFile(tempZipPath, fileBuffer);
    logsRef.value += `File saved to: ${tempZipPath}\n`;

    logsRef.value += `Extracting ZIP file to temporary local directory ${extractionPath}...\n`;
    const zip = await JSZip.loadAsync(fileBuffer);
    const fileNames: string[] = []; // Relative paths within the zip
    let packageJsonContent: string | null = null;

    // Extract all files locally first for inspection and build process
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

    logsRef.value += `Suggesting project name...\n`;
    try {
      const nameSuggestion = await suggestProjectName({ fileNames });
      finalProjectName = nameSuggestion.projectName.replace(/\s+/g, '-').toLowerCase();
      logsRef.value += `Suggested project name: ${finalProjectName}\n`;
    } catch (aiError) {
      logsRef.value += `AI project name suggestion failed: ${(aiError as Error).message}. Using default name.\n`;
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

    const storageRootPath = `sites/${finalProjectName}`;

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

        const buildDirs = ['build', 'dist', 'out']; // Common build output directories
        let buildSourcePath = ''; // Local path to build output
        for (const dir of buildDirs) {
          const potentialPath = path.join(extractionPath, dir);
          try {
            await fs.access(potentialPath); // Check if dir exists
             if ((await fs.stat(potentialPath)).isDirectory()) {
                buildSourcePath = potentialPath;
                break;
            }
          } catch { /* Directory does not exist or not accessible */ }
        }

        if (!buildSourcePath) {
          logsRef.value += `Error: Build output directory (build/, dist/, or out/) not found in ${extractionPath} after 'npm run build'.\n`;
          throw new Error('Build output directory not found.');
        }
        
        logsRef.value += `Uploading build files from ${buildSourcePath} to Firebase Storage at ${storageRootPath}...\n`;
        await uploadDirectoryRecursive(firebaseStorage, buildSourcePath, storageRootPath, logsRef);
        logsRef.value += `Build files uploaded successfully to Firebase Storage.\n`;

      } catch (buildError: any) {
        logsRef.value += `Build process failed: ${buildError.message}\n`;
        if (buildError.stdout) logsRef.value += `stdout: ${buildError.stdout}\n`;
        if (buildError.stderr) logsRef.value += `stderr: ${buildError.stderr}\n`;
        return { success: false, message: `Build process failed: ${buildError.message}`, logs: logsRef.value };
      }
    } else { // Static site
      logsRef.value += `Static site detected. Uploading files from ${extractionPath} to Firebase Storage at ${storageRootPath}...\n`;
      // For static sites, upload the contents of extractionPath directly
      await uploadDirectoryRecursive(firebaseStorage, extractionPath, storageRootPath, logsRef);
      logsRef.value += `Static files uploaded successfully to Firebase Storage.\n`;
    }

    // The deployedUrl will be handled by the new proxy route /sites/...
    const deployedUrl = `/sites/${finalProjectName}`; 
    logsRef.value += `Deployment successful. Access at: ${deployedUrl}\n`;

    return {
      success: true,
      message: 'Project deployed successfully to Firebase Storage!',
      projectName: finalProjectName,
      framework: detectedFramework,
      deployedUrl,
      logs: logsRef.value
    };

  } catch (error: any) {
    let detailedErrorMessage = error.message;
    if (error.code) { // FirebaseError often has a code
        detailedErrorMessage = `Firebase Storage Error (${error.code}): ${error.message}`;
    }
    // Attempt to get more info from serverResponse, which might exist on Firebase Storage errors
    // The actual structure of serverResponse can vary.
    if (error.serverResponse) {
        detailedErrorMessage += `\nServer Response: ${typeof error.serverResponse === 'string' ? error.serverResponse : JSON.stringify(error.serverResponse)}`;
    } else if (error.customData && error.customData.serverResponse) { // Sometimes nested
        detailedErrorMessage += `\nServer Response (customData): ${typeof error.customData.serverResponse === 'string' ? error.customData.serverResponse : JSON.stringify(error.customData.serverResponse)}`;
    }


    logsRef.value += `An error occurred: ${detailedErrorMessage}\nStack: ${error.stack || 'N/A'}\n`;
    console.error('Detailed Deployment error:', detailedErrorMessage, 'Full error object:', error);
    
    return { 
        success: false, 
        message: `Deployment failed. ${detailedErrorMessage}`, // Return the more detailed message
        logs: logsRef.value 
    };
  } finally {
    // Clean up temporary local files
    if (tempZipPath) {
      fs.unlink(tempZipPath).catch(err => console.error(`Failed to delete temp zip: ${tempZipPath}`, err));
    }
    // Clean up the entire uniqueId extraction directory
    if (extractionPath && extractionPath.startsWith(TEMP_UPLOAD_DIR) && extractionPath !== TEMP_UPLOAD_DIR) {
        // extractionPath is .../tmp/project_uploads/uniqueId/extracted
        // We want to delete .../tmp/project_uploads/uniqueId
        const dirToDelete = path.dirname(extractionPath); 
         if (dirToDelete && dirToDelete.startsWith(TEMP_UPLOAD_DIR) && dirToDelete !== TEMP_UPLOAD_DIR) {
             fs.rm(dirToDelete, { recursive: true, force: true })
                .catch(err => console.error(`Failed to delete temp extraction folder: ${dirToDelete}`, err));
        }
    }
  }
}

    