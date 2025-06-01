// src/ai/flows/detect-framework.ts
'use server';
/**
 * @fileOverview AI agent that detects whether an uploaded project is a React project or a static website.
 *
 * - detectFramework - A function that handles the framework detection process.
 * - DetectFrameworkInput - The input type for the detectFramework function.
 * - DetectFrameworkOutput - The return type for the detectFramework function.
 */

import {ai} from '@/ai/genkit';
import {z} from 'genkit';

const DetectFrameworkInputSchema = z.object({
  fileContents: z
    .string()
    .describe('The contents of the project files, preferably package.json if available.'),
});
export type DetectFrameworkInput = z.infer<typeof DetectFrameworkInputSchema>;

const DetectFrameworkOutputSchema = z.object({
  framework: z
    .enum(['react', 'static'])
    .describe('The detected framework type: react or static.'),
  confidence: z.number().describe('The confidence level of the detection (0-1).'),
});
export type DetectFrameworkOutput = z.infer<typeof DetectFrameworkOutputSchema>;

export async function detectFramework(input: DetectFrameworkInput): Promise<DetectFrameworkOutput> {
  return detectFrameworkFlow(input);
}

const prompt = ai.definePrompt({
  name: 'detectFrameworkPrompt',
  input: {schema: DetectFrameworkInputSchema},
  output: {schema: DetectFrameworkOutputSchema},
  prompt: `You are an expert software development framework detector.

You will be provided with the file contents of a project.  Your job is to determine
whether the project is a React project or a static website.  If it is a React project,
then output \"react\".  If it is a static website, then output \"static\".  Also, output a
confidence level between 0 and 1.

Here are the file contents:
\n\n{{fileContents}}\n\n`,
});

const detectFrameworkFlow = ai.defineFlow(
  {
    name: 'detectFrameworkFlow',
    inputSchema: DetectFrameworkInputSchema,
    outputSchema: DetectFrameworkOutputSchema,
  },
  async input => {
    const {output} = await prompt(input);
    return output!;
  }
);
