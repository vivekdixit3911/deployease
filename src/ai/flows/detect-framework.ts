
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
    .describe('The contents of the project files, preferably package.json if available, or index.html otherwise.'),
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
Your task is to determine if the provided file content indicates a React-based project or a static HTML/CSS/JS website.

Input will typically be the content of a 'package.json' file or an 'index.html' file.

Criteria for "react":
- If 'fileContents' is from a 'package.json':
  - Look for "react" and "react-dom" in dependencies or devDependencies.
  - Look for packages like "next", "react-scripts", "vite" (especially if its config implies React usage).
  - Look for scripts in 'package.json' like "start": "react-scripts start", "build": "react-scripts build", "dev": "next dev", "build": "next build", or similar Vite/Parcel build commands for React.
- If 'fileContents' is from an 'index.html' AND no 'package.json' was likely available for analysis:
  - It's less likely to be a complex React *build* project. Consider it "static" unless there are very clear script tags importing React from a CDN for a simple embed. However, prioritize 'package.json' indicators if available. If the index.html contains a common React root div like <div id="root"></div> or <div id="app"></div>, it might be a React project, but 'package.json' is a stronger signal.

Criteria for "static":
- If 'fileContents' is from an 'index.html' and does not show clear signs of being a placeholder for a React app (e.g., it's a complete HTML page, and no 'package.json' with React indicators was provided).
- If 'fileContents' is from a 'package.json' but lacks strong React indicators (e.g., no "react" in dependencies, no common React build scripts).

Output "react" if it's a React project.
Output "static" if it's a static website.
Also, output a confidence level between 0 and 1. A higher confidence should be given if 'package.json' clearly indicates React.

File Contents:
{{{fileContents}}}
`,
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

