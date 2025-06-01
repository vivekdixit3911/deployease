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
  projectName: z.string().describe('A suggested name for the project based on its files.'),
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

      Files: {{fileNames}}

      Please suggest a project name. Be creative but relevant to the file types. Return only the project name.`,
});

const suggestProjectNameFlow = ai.defineFlow(
  {
    name: 'suggestProjectNameFlow',
    inputSchema: SuggestProjectNameInputSchema,
    outputSchema: SuggestProjectNameOutputSchema,
  },
  async input => {
    const {output} = await prompt(input);
    return output!;
  }
);
