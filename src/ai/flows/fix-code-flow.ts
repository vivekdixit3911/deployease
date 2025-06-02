
'use server';
/**
 * @fileOverview An AI agent that attempts to fix build errors in user code.
 *
 * - fixCodeInFile - A function that attempts to fix code in a given file based on an error message.
 * - FixCodeInput - The input type for the fixCodeInFile function.
 * - FixCodeOutput - The return type for the fixCodeInFile function.
 */

import {ai} from '@/ai/genkit';
import {z} from 'genkit';

const FixCodeInputSchema = z.object({
  filePath: z.string().describe('The relative path of the file that has an error.'),
  fileContent: z.string().describe('The full original content of the file with the error.'),
  errorMessage: z.string().describe('The specific error message reported by the build tool for this file.'),
  projectContext: z.string().optional().describe("A brief description of the project type or framework, e.g., 'Next.js TypeScript project', 'React JavaScript app'. This helps the AI understand the environment."),
});
export type FixCodeInput = z.infer<typeof FixCodeInputSchema>;

const FixCodeOutputSchema = z.object({
  fixedFileContent: z.string().describe("The ENTIRE content of the file with the suggested fix applied. If no fix is possible or confident, this should be the original fileContent."),
  confidence: z.number().min(0).max(1).optional().describe('Confidence in the fix (0.0 to 1.0). If low, fixedFileContent might be the original content.'),
  reasoning: z.string().optional().describe("Reasoning for the fix, or an explanation if no fix was made or if the original content is returned."),
  fixApplied: z.boolean().describe("True if a change was made to the original fileContent, false otherwise."),
});
export type FixCodeOutput = z.infer<typeof FixCodeOutputSchema>;

export async function fixCodeInFile(input: FixCodeInput): Promise<FixCodeOutput> {
  return fixCodeFlow(input);
}

const prompt = ai.definePrompt({
  name: 'fixCodePrompt',
  input: {schema: FixCodeInputSchema},
  output: {schema: FixCodeOutputSchema},
  prompt: `You are an expert software engineer and debugging assistant.
A user's project build failed. I will provide you with the content of a specific file from their project, its relative path, the error message associated with it, and some context about the project.

Your task is to analyze the error and the file content, and then provide a corrected version of THE ENTIRE FILE.

Project Context: {{{projectContext}}}
File Path: {{{filePath}}}
Error Message:
\`\`\`
{{{errorMessage}}}
\`\`\`

Original File Content:
\`\`\`
{{{fileContent}}}
\`\`\`

Instructions for your response:
1.  Carefully analyze the error message in conjunction with the file content.
2.  If you can identify a clear fix for the error (e.g., syntax errors, type errors, common linting issues, incorrect variable names, simple logic errors), apply the fix.
3.  Return the **ENTIRE, MODIFIED file content** in the 'fixedFileContent' field of your JSON output. Do NOT provide only a diff, a snippet, or an explanation of how to fix it; provide the complete file ready to be saved.
4.  Set 'fixApplied' to true if you made any changes to 'fileContent'.
5.  Set 'confidence' to a value between 0.0 (not confident at all) and 1.0 (very confident).
6.  Provide a brief 'reasoning' for your change, or explain why you couldn't make a confident fix.
7.  **If you cannot confidently fix the error, OR if the error seems like it requires broader project changes beyond this single file (e.g., missing a complex dependency, major architectural issue), OR if the error message is too vague, then you MUST return the original 'fileContent' in the 'fixedFileContent' field, set 'fixApplied' to false, and explain why in the 'reasoning'.**
8.  Do NOT add comments to the code that were not there originally, unless adding/fixing a comment is the specific solution to the error.
9.  Focus on a single, targeted fix for the provided error. Do not attempt to refactor large portions of the code or introduce new functionalities.
10. Ensure your output is a valid JSON object matching the defined schema.
`,
  // Lower temperature for more deterministic fixes
  config: {
    temperature: 0.2,
     safetySettings: [
      {
        category: 'HARM_CATEGORY_DANGEROUS_CONTENT',
        threshold: 'BLOCK_NONE',
      }
    ]
  }
});

const fixCodeFlow = ai.defineFlow(
  {
    name: 'fixCodeFlow',
    inputSchema: FixCodeInputSchema,
    outputSchema: FixCodeOutputSchema,
  },
  async (input) => {
    const {output} = await prompt(input);
    if (!output) {
      return {
        fixedFileContent: input.fileContent,
        confidence: 0,
        reasoning: "AI model did not return a valid response. Original content preserved.",
        fixApplied: false,
      };
    }
    // Ensure fixApplied is correctly set if content changed.
    // This is a fallback; ideally the model sets it correctly.
    if (output.fixedFileContent !== input.fileContent && output.fixApplied === false) {
        // If content changed but model said no fix applied, override.
        // However, if model claims fixApplied:true but content is same, that's fine (e.g. it confirmed no change needed)
        if(output.reasoning && !output.reasoning.includes("No change needed")){
             output.reasoning = (output.reasoning || "") + " (Note: Content differed from original, so 'fixApplied' was set to true.)";
        }
        output.fixApplied = true;
    }


    return output;
  }
);
