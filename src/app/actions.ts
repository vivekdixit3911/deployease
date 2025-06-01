
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
import { detectFramework, DetectFrameworkInput, DetectFrameworkOutput } from '@/ai/flows/detect-framework';

const execAsync = promisify(exec);

interface DeploymentResult {
  success: boolean;
  message: string;
  projectName?: string;
  framework?: DetectFrameworkOutput['framework'];
  build_command?: string;
  output_directory?: string;
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
  let extractionPath = ''; 
  let projectRootPath = ''; 
  let frameworkDetectionResult: DetectFrameworkOutput = { 
    framework: 'static', 
    confidence: 0, 
    reasoning: "Initial value",
    build_command: undefined,
    output_directory: undefined
  };
  const minNameLength = 3;
  let finalProjectName = 'untitled-project';
  
  try {
    if (!OLA_S3_BUCKET_NAME) {
        logsRef.value += 'Error: S3 bucket name (OLA_S3_BUCKET_NAME) is not configured in environment variables.\n';
        throw new Error('S3 bucket name (OLA_S3_BUCKET_NAME) is not configured.');
    }
    s3Client(); 

    await ensureDirectoryExists(TEMP_UPLOAD_DIR);
    
    const uniqueId = `${Date.now()}-${Math.random().toString(36).substring(2, 9)}`;
    const uniqueExtractionDir = path.join(TEMP_UPLOAD_DIR, uniqueId); 
    tempZipPath = path.join(uniqueExtractionDir, file.name); 
    extractionPath = path.join(uniqueExtractionDir, 'extracted'); 
    await ensureDirectoryExists(extractionPath);
    logsRef.value += `Root extraction path: ${extractionPath}\n`;

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

    logsRef.value += `Determining project name...\n`;
    let aiSuggestion = '';
    try {
      const nameSuggestionOutput = await suggestProjectName({ fileNames: fileNamesInZip });
      aiSuggestion = sanitizeName(nameSuggestionOutput.projectName);
      logsRef.value += `AI suggested name (raw: "${nameSuggestionOutput.projectName}", sanitized: "${aiSuggestion}")\n`;
    } catch (error) {
      logsRef.value += `AI project name suggestion failed: ${(error as Error).message}. Using fallback.\n`;
      aiSuggestion = 'untitled-project'; // Fallback
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
      finalProjectName = 'untitled-project'; // Ensure it's set if other conditions fail
      logsRef.value += `Both AI and file-based names are unsuitable or too short. Using default name: ${finalProjectName}\n`;
    }
    
    logsRef.value += `Detecting framework...\n`;
    let frameworkInput: DetectFrameworkInput = { fileContents: 'No package.json or index.html found for analysis.', fileNameAnalyzed: 'unknown' };
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
            await findFilesRecursive(fullPath);
          } else if (entry.name.toLowerCase() === 'package.json') {
            packageJsonPaths.push(relativeToExtraction);
          } else if (entry.name.toLowerCase() === 'index.html') {
            if (!relativeToExtraction.includes('/build/') && !relativeToExtraction.includes('/dist/') && !relativeToExtraction.includes('/out/') && !relativeToExtraction.includes('/node_modules/')) {
                indexHtmlPaths.push(relativeToExtraction);
            }
          }
        }
      };
      await findFilesRecursive(currentSearchPath);
      
      packageJsonPaths.sort((a, b) => a.split('/').length - b.split('/').length);
      indexHtmlPaths.sort((a, b) => a.split('/').length - b.split('/').length);

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
        frameworkInput = { fileContents: analysisFileContent, fileNameAnalyzed: analysisFileRelativePath };
        logsRef.value += `Framework detection input: content of '${analysisFileRelativePath}'. Project root set to: ${projectRootPath}\n`;
    } else {
        logsRef.value += `No suitable package.json or index.html found for framework detection. Defaulting to project root: ${projectRootPath}\n`;
        frameworkInput = { fileContents: `No primary analysis files (package.json, index.html) found in ZIP. Analyzed files: ${fileNamesInZip.join(', ')}`, fileNameAnalyzed: 'none_found' };
    }
        
    logsRef.value += `Content for framework detection (first 500 chars of ${frameworkInput.fileNameAnalyzed}):\n---\n${frameworkInput.fileContents.substring(0, 500)}${frameworkInput.fileContents.length > 500 ? '...' : ''}\n---\n`;

    try {
      frameworkDetectionResult = await detectFramework(frameworkInput);
      logsRef.value += `AI Detected framework: ${frameworkDetectionResult.framework} (Confidence: ${frameworkDetectionResult.confidence})\n`;
      logsRef.value += `AI Reasoning: ${frameworkDetectionResult.reasoning || 'N/A'}\n`;
      if (frameworkDetectionResult.framework === 'react') {
        logsRef.value += `AI Suggested build command: ${frameworkDetectionResult.build_command || 'N/A'}\n`;
        logsRef.value += `AI Suggested output directory: ${frameworkDetectionResult.output_directory || 'N/A'}\n`;
      }
    } catch (aiError: any) {
      logsRef.value += `AI framework detection failed: ${(aiError as Error).message}. Stack: ${aiError.stack || 'N/A'}. Assuming 'static' due to error.\n`;
      frameworkDetectionResult = { 
        framework: 'static', 
        confidence: 0.1, 
        reasoning: "AI detection failed, defaulted to static",
        build_command: undefined,
        output_directory: undefined
      };
    }

    const s3ProjectBaseKey = `sites/${finalProjectName}`; 
    logsRef.value += `Final detected framework for build process: ${frameworkDetectionResult.framework}\n`;
    logsRef.value += `Project root path for build/upload: ${projectRootPath}\n`;

    if (frameworkDetectionResult.framework === 'react') {
      logsRef.value += `React project detected. Starting build process in ${projectRootPath}...\n`;
      try {
        logsRef.value += `Running 'npm install' in ${projectRootPath}...\n`;
        const installOutput = await execAsync('npm install', { cwd: projectRootPath });
        logsRef.value += `npm install stdout:\n${installOutput.stdout || 'N/A'}\n`;
        if (installOutput.stderr) logsRef.value += `npm install stderr:\n${installOutput.stderr}\n`;

        const buildCommand = frameworkDetectionResult.build_command || 'npm run build';
        logsRef.value += `Running build command: '${buildCommand}' in ${projectRootPath}...\n`;
        const buildOutput = await execAsync(buildCommand, { cwd: projectRootPath });
        logsRef.value += `Build command stdout:\n${buildOutput.stdout || 'N/A'}\n`;
        if (buildOutput.stderr) logsRef.value += `Build command stderr:\n${buildOutput.stderr}\n`;

        const suggestedOutputDir = frameworkDetectionResult.output_directory;
        const defaultOutputDirs = ['build', 'dist', 'out', '.next']; 
        const outputDirsToTry = suggestedOutputDir ? [suggestedOutputDir, ...defaultOutputDirs.filter(d => d !== suggestedOutputDir)] : defaultOutputDirs;
        
        let buildSourcePath = ''; 
        for (const dir of outputDirsToTry) {
          const potentialPath = path.join(projectRootPath, dir);
          try {
            await fs.access(potentialPath); 
             if ((await fs.stat(potentialPath)).isDirectory()) { 
                buildSourcePath = potentialPath;
                logsRef.value += `Found build output directory at: ${buildSourcePath}\n`;
                break;
            }
          } catch { /* Directory does not exist or not accessible */ }
        }

        if (!buildSourcePath) {
          logsRef.value += `Error: Build output directory (tried: ${outputDirsToTry.join(', ')}) not found in ${projectRootPath} after build. Listing directory contents of ${projectRootPath}:\n`;
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
        return { 
            success: false, 
            message: `React build process failed: ${buildError.message}`, 
            logs: logsRef.value, 
            projectName: finalProjectName, 
            framework: frameworkDetectionResult.framework,
            build_command: frameworkDetectionResult.build_command,
            output_directory: frameworkDetectionResult.output_directory
        };
      }
    } else { 
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
      framework: frameworkDetectionResult.framework,
      build_command: frameworkDetectionResult.build_command,
      output_directory: frameworkDetectionResult.output_directory,
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
        framework: frameworkDetectionResult.framework,
        build_command: frameworkDetectionResult.build_command,
        output_directory: frameworkDetectionResult.output_directory
    };
  } finally {
    if (extractionPath) { 
      const uniqueExtractionDirToDelete = path.dirname(extractionPath); 
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
    } else if (tempZipPath) { 
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

