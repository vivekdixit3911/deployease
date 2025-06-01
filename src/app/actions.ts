// src/app/actions.ts
'use server';

import fs from 'fs/promises';
import path from 'path';
import { exec } from 'child_process';
import { promisify } from 'util';
import JSZip from 'jszip';
import { TEMP_UPLOAD_DIR, SITES_DIR } from '@/config/constants';
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
  let finalProjectName = 'untitled-project';
  let detectedFramework = 'unknown';
  let logs = '';

  try {
    await ensureDirectoryExists(TEMP_UPLOAD_DIR);
    
    const uniqueId = `${Date.now()}-${Math.random().toString(36).substring(2, 9)}`;
    tempZipPath = path.join(TEMP_UPLOAD_DIR, `${uniqueId}-${file.name}`);
    extractionPath = path.join(TEMP_UPLOAD_DIR, uniqueId, 'extracted');
    await ensureDirectoryExists(extractionPath);

    logs += `Uploading file: ${file.name}\n`;
    const fileBuffer = Buffer.from(await file.arrayBuffer());
    await fs.writeFile(tempZipPath, fileBuffer);
    logs += `File saved to: ${tempZipPath}\n`;

    logs += `Extracting ZIP file...\n`;
    const zip = await JSZip.loadAsync(fileBuffer);
    const fileNames: string[] = [];
    let packageJsonContent: string | null = null;

    for (const PURELY_RECURSIVE_EXTRACTION_LOGIC_filePath in zip.files) {
      if (!zip.files[PURELY_RECURSIVE_EXTRACTION_LOGIC_filePath].dir) {
        const content = await zip.files[PURELY_RECURSIVE_EXTRACTION_LOGIC_filePath].async('nodebuffer');
        const PURELY_RECURSIVE_EXTRACTION_LOGIC_destPath = path.join(extractionPath, PURELY_RECURSIVE_EXTRACTION_LOGIC_filePath);
        await ensureDirectoryExists(path.dirname(PURELY_RECURSIVE_EXTRACTION_LOGIC_destPath));
        await fs.writeFile(PURELY_RECURSIVE_EXTRACTION_LOGIC_destPath, content);
        fileNames.push(PURELY_RECURSIVE_EXTRACTION_LOGIC_filePath);
        if (PURELY_RECURSIVE_EXTRACTION_LOGIC_filePath.endsWith('package.json') || PURELY_RECURSIVE_EXTRACTION_LOGIC_filePath === 'package.json') {
           packageJsonContent = content.toString('utf-8');
        }
      }
    }
    logs += `ZIP extraction complete. Files: ${fileNames.join(', ')}\n`;
    
    if (fileNames.length === 0) {
      return { success: false, message: 'The uploaded ZIP file is empty or invalid.', logs };
    }

    // Suggest project name
    logs += `Suggesting project name...\n`;
    try {
      const nameSuggestion = await suggestProjectName({ fileNames });
      finalProjectName = nameSuggestion.projectName.replace(/\s+/g, '-').toLowerCase();
      logs += `Suggested project name: ${finalProjectName}\n`;
    } catch (aiError) {
      logs += `AI project name suggestion failed: ${(aiError as Error).message}. Using default name.\n`;
    }
    
    // Detect framework
    logs += `Detecting framework...\n`;
    let frameworkInputContent = 'No package.json found.';
    if (packageJsonContent) {
        frameworkInputContent = packageJsonContent;
    } else {
        // Fallback: try to get index.html content if package.json is not found
        const indexHtmlPath = fileNames.find(name => name.endsWith('index.html'));
        if (indexHtmlPath) {
            const indexHtmlFullPath = path.join(extractionPath, indexHtmlPath);
            try {
                frameworkInputContent = await fs.readFile(indexHtmlFullPath, 'utf-8');
                 logs += `Using index.html content for framework detection.\n`;
            } catch (readError) {
                logs += `Could not read index.html: ${(readError as Error).message}\n`;
            }
        }
    }

    try {
      const frameworkDetection = await detectFramework({ fileContents: frameworkInputContent });
      detectedFramework = frameworkDetection.framework;
      logs += `Detected framework: ${detectedFramework} (Confidence: ${frameworkDetection.confidence})\n`;
    } catch (aiError) {
      logs += `AI framework detection failed: ${(aiError as Error).message}. Assuming 'static'.\n`;
      detectedFramework = 'static'; // Default to static if detection fails
    }

    await ensureDirectoryExists(SITES_DIR);
    const deployPath = path.join(SITES_DIR, finalProjectName);
    await ensureDirectoryExists(deployPath); // Ensure project-specific site directory exists

    if (detectedFramework === 'react') {
      logs += `React project detected. Starting build process...\n`;
      try {
        logs += `Running 'npm install' in ${extractionPath}...\n`;
        const installOutput = await execAsync('npm install', { cwd: extractionPath });
        logs += `npm install stdout: ${installOutput.stdout}\n`;
        if (installOutput.stderr) logs += `npm install stderr: ${installOutput.stderr}\n`;

        logs += `Running 'npm run build' in ${extractionPath}...\n`;
        const buildOutput = await execAsync('npm run build', { cwd: extractionPath });
        logs += `npm run build stdout: ${buildOutput.stdout}\n`;
        if (buildOutput.stderr) logs += `npm run build stderr: ${buildOutput.stderr}\n`;

        const buildDirs = ['build', 'dist']; // Common build output directories
        let buildSourcePath = '';
        for (const dir of buildDirs) {
          const potentialPath = path.join(extractionPath, dir);
          try {
            await fs.access(potentialPath);
            buildSourcePath = potentialPath;
            break;
          } catch { /* Directory does not exist */ }
        }

        if (!buildSourcePath) {
          logs += `Error: Build output directory (build/ or dist/) not found after 'npm run build'.\n`;
          throw new Error('Build output directory not found.');
        }
        
        logs += `Copying build files from ${buildSourcePath} to ${deployPath}...\n`;
        await fs.cp(buildSourcePath, deployPath, { recursive: true });
        logs += `Build files copied successfully.\n`;

      } catch (buildError: any) {
        logs += `Build process failed: ${buildError.message}\n`;
        if (buildError.stdout) logs += `stdout: ${buildError.stdout}\n`;
        if (buildError.stderr) logs += `stderr: ${buildError.stderr}\n`;
        return { success: false, message: `Build process failed: ${buildError.message}`, logs };
      }
    } else { // Static site
      logs += `Static site detected. Copying files...\n`;
      await fs.cp(extractionPath, deployPath, { recursive: true });
      logs += `Static files copied successfully from ${extractionPath} to ${deployPath}.\n`;
    }

    const deployedUrl = `/sites/${finalProjectName}`;
    logs += `Deployment successful. Access at: ${deployedUrl}\n`;

    return {
      success: true,
      message: 'Project deployed successfully!',
      projectName: finalProjectName,
      framework: detectedFramework,
      deployedUrl,
      logs
    };

  } catch (error: any) {
    logs += `An error occurred: ${error.message}\n Stack: ${error.stack}\n`;
    console.error('Deployment error:', error);
    return { success: false, message: `Deployment failed: ${error.message}`, logs };
  } finally {
    // Clean up temporary files
    if (tempZipPath) {
      fs.unlink(tempZipPath).catch(err => console.error(`Failed to delete temp zip: ${tempZipPath}`, err));
    }
    if (extractionPath && extractionPath !== TEMP_UPLOAD_DIR) { // Don't delete the root temp dir, just the specific extraction
        const parentExtractionDir = path.dirname(extractionPath); // This is .../tmp/project_uploads/uniqueId
        if (parentExtractionDir && parentExtractionDir.startsWith(TEMP_UPLOAD_DIR) && parentExtractionDir !== TEMP_UPLOAD_DIR) {
             fs.rm(parentExtractionDir, { recursive: true, force: true })
                .catch(err => console.error(`Failed to delete temp extraction folder: ${parentExtractionDir}`, err));
        }
    }
  }
}
