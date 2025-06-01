
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
The input 'fileContents' will typically be the content of a 'package.json' file or an 'index.html' file.

**Analysis based on 'package.json' (Highest Priority):**
If 'fileContents' is from a 'package.json':
1.  **Dependencies:** Look for "react" AND "react-dom" in "dependencies" or "devDependencies". Their presence is a very strong indicator of a React project.
2.  **Build Tools/Scripts:**
    *   Look for packages like "next", "react-scripts", "vite", "@remix-run/dev", or "parcel-bundler" (if configured for React) in dependencies or devDependencies.
    *   Examine the "scripts" section for commands like:
        *   "start": "react-scripts start", "build": "react-scripts build"
        *   "dev": "next dev", "build": "next build"
        *   "dev": "vite", "build": "vite build" (especially if React plugins are used with Vite)
        *   "dev": "remix dev", "build": "remix build"
    *   The presence of such scripts strongly suggests a "react" project.
3.  If "react" AND "react-dom" are present in dependencies/devDependencies, OR if common React-specific build scripts (like those mentioned above) are found, classify as "react" with high confidence (e.g., 0.9 or higher). Even if only one of these strong signals is present, lean towards "react".

**Analysis based on 'index.html' (Fallback if no 'package.json' was suitable for analysis):**
If 'fileContents' is from an 'index.html' AND no 'package.json' with React indicators was provided or analyzed:
1.  An 'index.html' alone usually means a "static" site.
2.  If it contains script tags importing React from a CDN (e.g., <script src=".../react.development.js"></script> and <script src=".../react-dom.development.js"></script>) AND a root div (e.g., <div id="root"></div> or <div id="app"></div>), it *might* be a simple React setup. If no 'package.json' was available for analysis, and these specific CDN and root div patterns are seen, you can classify as "react" but with moderate confidence (e.g., 0.6-0.7).
3.  Otherwise, if it's a standard complete HTML page without clear React CDN usage, classify as "static" with high confidence.

**Default/Uncertainty:**
If 'fileContents' is from a 'package.json' but lacks clear React indicators (no "react"/"react-dom" in dependencies, no typical React build scripts), classify as "static".
If no 'package.json' was available for analysis and the 'index.html' does not clearly indicate React via CDN usage as described above, classify as "static".

Output "react" if it's a React project.
Output "static" if it's a static website.
Provide a confidence level between 0 and 1 for your detection.

File Contents to analyze:
\`\`\`
{{{fileContents}}}
\`\`\`
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
