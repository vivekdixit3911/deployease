
'use server';

/**
 * @fileOverview Suggests a project name based on the uploaded files.
 *
 * - suggestProjectName - A function that suggests a project name.
 * - SuggestProjectNameInput - The input type for the suggestProjectName function.
 * - SuggestProjectNameOutput - The return type for the suggestProjectName function.
 */

import {ai} from '@/ai/genkit';
import {z} from 'genkit';

const SuggestProjectNameInputSchema = z.object({
  fileNames: z.array(z.string()).describe('An array of file names from the uploaded archive.'),
});
export type SuggestProjectNameInput = z.infer<typeof SuggestProjectNameInputSchema>;

const SuggestProjectNameOutputSchema = z.object({
  projectName: z.string().describe('A suggested name for the project based on its files. Should be creative but relevant. Avoid generic names like "project" or "untitled". If no clear idea, default to "web-creation".'),
});
export type SuggestProjectNameOutput = z.infer<typeof SuggestProjectNameOutputSchema>;

export async function suggestProjectName(input: SuggestProjectNameInput): Promise<SuggestProjectNameOutput> {
  return suggestProjectNameFlow(input);
}

const prompt = ai.definePrompt({
  name: 'suggestProjectNamePrompt',
  input: {schema: SuggestProjectNameInputSchema},
  output: {schema: SuggestProjectNameOutputSchema},
  prompt: `You are an expert project naming assistant. Given the list of files in a project, you will suggest a suitable project name.
The name should be creative, catchy, and relevant to the file types or potential purpose hinted at by the file names.
Avoid generic names like "project", "app", "website", or "untitled-project".
If the files are very generic (e.g., just index.html, style.css), aim for something like "Web-Canvas", "Digital-Sketchpad", or "My-First-Site".
If you cannot determine a good name, default to "Web-Creation".
Return only the JSON object with the "projectName" field.

Files:
{{#each fileNames}}
- {{{this}}}
{{/each}}

Suggest a project name based on these files.
`,
});

const suggestProjectNameFlow = ai.defineFlow(
  {
    name: 'suggestProjectNameFlow',
    inputSchema: SuggestProjectNameInputSchema,
    outputSchema: SuggestProjectNameOutputSchema,
  },
  async input => {
    const {output} = await prompt(input);
    if (!output || !output.projectName) {
      // Fallback in case AI fails to return valid JSON or an empty name
      return { projectName: 'Web-Creation-Fallback' };
    }
    return output;
  }
);
