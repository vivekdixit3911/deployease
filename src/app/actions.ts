
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
  s3BaseKey: string,
  logsRef: { value: string }
) {
  if (!OLA_S3_BUCKET_NAME) {
    logsRef.value += 'Error: OLA_S3_BUCKET_NAME is not configured.\n';
    throw new Error('OLA_S3_BUCKET_NAME is not configured.');
  }
  const currentS3Client = s3Client();

  const entries = await fs.readdir(localDirPath, { withFileTypes: true });
  for (const entry of entries) {
    const localEntryPath = path.join(localDirPath, entry.name);
    const cleanEntryName = entry.name.replace(/^\/+|\/+$/g, '');
    // Ensure s3ObjectKey correctly represents the path within the s3BaseKey "folder"
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
  let extractionPath = ''; // Root directory where ZIP contents are extracted
  let projectRootPath = ''; // Actual root of the project within extractionPath (e.g., extractionPath or extractionPath/subdir)
  let detectedFramework = 'unknown';
  const minNameLength = 3;
  let finalProjectName = 'untitled-project';
  
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
    logsRef.value += `Root extraction path: ${extractionPath}\n`;

    logsRef.value += `Processing uploaded file: ${file.name}\n`;
    const fileBuffer = Buffer.from(await file.arrayBuffer());
    await fs.writeFile(tempZipPath, fileBuffer); // Save zip temporarily for record/debug if needed
    logsRef.value += `Temporary ZIP file saved to: ${tempZipPath}\n`;

    const zip = await JSZip.loadAsync(fileBuffer);
    const fileNamesInZip: string[] = []; // All relative file paths from the zip
    let projectPackageJsonRelativePath: string | null = null; // Relative path to the chosen package.json within zip
    let projectPackageJsonContent: string | null = null;
    const allPackageJsonPathsInZip: string[] = [];

    // First pass: identify all files and potential package.json files
    for (const relativePathInZip in zip.files) {
        // Record all files, not just non-directories, for project name suggestion
        fileNamesInZip.push(relativePathInZip);
        if (!zip.files[relativePathInZip].dir && path.basename(relativePathInZip) === 'package.json') {
            allPackageJsonPathsInZip.push(relativePathInZip);
        }
    }
    logsRef.value += `Found ${allPackageJsonPathsInZip.length} package.json file(s) in ZIP at: ${allPackageJsonPathsInZip.join(', ') || 'None'}\n`;

    if (allPackageJsonPathsInZip.length > 0) {
      allPackageJsonPathsInZip.sort((a, b) => a.split('/').length - b.split('/').length); // Prefer shallowest
      projectPackageJsonRelativePath = allPackageJsonPathsInZip[0];
      logsRef.value += `Selected package.json for analysis: ${projectPackageJsonRelativePath}\n`;
      try {
        const content = await zip.file(projectPackageJsonRelativePath)!.async('nodebuffer');
        projectPackageJsonContent = content.toString('utf-8');
      } catch (e) {
        logsRef.value += `Error reading content of selected package.json (${projectPackageJsonRelativePath}): ${(e as Error).message}\n`;
      }
    }

    // Determine projectRootPath (actual root for npm commands or static uploads)
    projectRootPath = extractionPath; // Default to the root of extracted files
    if (projectPackageJsonRelativePath) {
      projectRootPath = path.join(extractionPath, path.dirname(projectPackageJsonRelativePath));
    }
    logsRef.value += `Initial project root for execution determined as: ${projectRootPath}\n`;
    
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
    logsRef.value += `ZIP extraction to ${extractionPath} complete. All files from ZIP: ${fileNamesInZip.join(', ')}\n`;
    
    if (fileNamesInZip.length === 0) {
      return { success: false, message: 'The uploaded ZIP file is empty or invalid.', logs: logsRef.value };
    }

    logsRef.value += `Determining project name...\n`;
    let aiSuggestion = '';
    try {
      const nameSuggestionOutput = await suggestProjectName({ fileNames: fileNamesInZip }); // Use all file names from zip
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
      logsRef.value += `Both AI and file-based names are unsuitable. Using default name: ${finalProjectName}\n`;
    }
    
    logsRef.value += `Detecting framework...\n`;
    let frameworkInputContent = 'No package.json or index.html found for analysis.';
    let analysisBasis = '';

    if (projectPackageJsonContent) {
        frameworkInputContent = projectPackageJsonContent;
        analysisBasis = `content of ${projectPackageJsonRelativePath}`;
    } else {
        // No package.json found or chosen, try to find an index.html for analysis.
        // Prefer index.html at the determined projectRootPath (which is extractionPath if no package.json found)
        // or at the very root of the zip.
        const searchPathsForIndexHtml = [
            path.join(projectRootPath, 'index.html'), // Full path
            path.join(extractionPath, 'index.html')   // Full path
        ].filter((p, i, arr) => arr.indexOf(p) === i); // Unique full paths

        let foundIndexHtmlFullPath: string | null = null;
        for (const p of searchPathsForIndexHtml) {
            try {
                await fs.access(p); // Check if file exists
                foundIndexHtmlFullPath = p;
                break;
            } catch { /* file doesn't exist at this path */ }
        }
        
        // If not in preferred locations, search more broadly within extracted files (less ideal)
        if (!foundIndexHtmlFullPath) {
            const findInExtracted = async (dir: string) : Promise<string | null> => {
                const entries = await fs.readdir(dir, { withFileTypes: true });
                for (const entry of entries) {
                    const entryPath = path.join(dir, entry.name);
                    if (entry.isDirectory()) {
                        const found = await findInExtracted(entryPath);
                        if (found) return found;
                    } else if (entry.name === 'index.html') {
                        return entryPath;
                    }
                }
                return null;
            }
            foundIndexHtmlFullPath = await findInExtracted(extractionPath);
        }

        if (foundIndexHtmlFullPath) {
            try {
                frameworkInputContent = await fs.readFile(foundIndexHtmlFullPath, 'utf-8');
                analysisBasis = `content of ${path.relative(extractionPath, foundIndexHtmlFullPath)}`;
                 // If we are using index.html because no package.json, the projectRootPath for static upload
                 // should be the directory containing this index.html.
                 if (!projectPackageJsonRelativePath) { 
                    projectRootPath = path.dirname(foundIndexHtmlFullPath);
                    logsRef.value += `Adjusted project root for static site based on index.html to: ${projectRootPath}\n`;
                 }
            } catch (readError) {
                logsRef.value += `Could not read found index.html at ${foundIndexHtmlFullPath}: ${(readError as Error).message}\n`;
                analysisBasis = 'Error reading index.html';
            }
        } else {
            logsRef.value += `No suitable package.json or index.html found for framework detection.\n`;
            analysisBasis = 'No files for analysis';
        }
    }
    logsRef.value += `Framework detection basis: ${analysisBasis}.\n`;

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
      logsRef.value += `React project detected. Starting build process in ${projectRootPath}...\n`;
      try {
        logsRef.value += `Running 'npm install' in ${projectRootPath}...\n`;
        const installOutput = await execAsync('npm install', { cwd: projectRootPath });
        logsRef.value += `npm install stdout: ${installOutput.stdout || 'N/A'}\n`;
        if (installOutput.stderr) logsRef.value += `npm install stderr: ${installOutput.stderr}\n`;

        logsRef.value += `Running 'npm run build' in ${projectRootPath}...\n`;
        const buildOutput = await execAsync('npm run build', { cwd: projectRootPath });
        logsRef.value += `npm run build stdout: ${buildOutput.stdout || 'N/A'}\n`;
        if (buildOutput.stderr) logsRef.value += `npm run build stderr: ${buildOutput.stderr}\n`;

        const buildDirs = ['build', 'dist', 'out'];
        let buildSourcePath = ''; // This will be the absolute path to the build output dir
        for (const dir of buildDirs) {
          const potentialPath = path.join(projectRootPath, dir);
          try {
            await fs.access(potentialPath);
             if ((await fs.stat(potentialPath)).isDirectory()) {
                buildSourcePath = potentialPath;
                logsRef.value += `Found build output directory at: ${buildSourcePath}\n`;
                break;
            }
          } catch { /* Directory does not exist */ }
        }

        if (!buildSourcePath) {
          logsRef.value += `Error: Build output directory (build/, dist/, or out/) not found in ${projectRootPath} after 'npm run build'.\n`;
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
    // Delete the entire uniqueId folder which contains 'extracted' and the temp zip (if logic moved it there)
    if (extractionPath && extractionPath.startsWith(TEMP_UPLOAD_DIR)) {
        const dirToDelete = path.dirname(extractionPath); // This should be the 'uniqueId' folder
         if (dirToDelete && dirToDelete !== TEMP_UPLOAD_DIR && dirToDelete.startsWith(TEMP_UPLOAD_DIR)) {
             fs.rm(dirToDelete, { recursive: true, force: true })
                .catch(err => console.error(`Failed to delete temp extraction base folder: ${dirToDelete}`, err));
        } else if (extractionPath !== TEMP_UPLOAD_DIR) { // Fallback if structure is just extractionPath
             fs.rm(extractionPath, { recursive: true, force: true })
                .catch(err => console.error(`Failed to delete temp extraction folder: ${extractionPath}`, err));
        }
    }
  }
}

