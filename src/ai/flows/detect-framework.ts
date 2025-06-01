
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
    .describe('The contents of the project files, EITHER package.json (highest priority) or index.html.'),
  fileNameAnalyzed: z.string().describe("The name of the file whose content is being analyzed (e.g., 'package.json' or 'index.html')."),
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
The input 'fileContents' is from the file named '{{{fileNameAnalyzed}}}'.

**PRIORITY 1: Analysis IF '{{{fileNameAnalyzed}}}' is 'package.json':**
If '{{{fileNameAnalyzed}}}' is 'package.json':
1.  **Search for "react" AND "react-dom" in "dependencies" or "devDependencies"**:
    *   If "dependencies" contains BOTH "react" AND "react-dom", classify as "react" with 0.98 confidence.
    *   Else if "devDependencies" contains BOTH "react" AND "react-dom", classify as "react" with 0.95 confidence.
2.  **Search for React-specific build tools/scripts (if not already classified as React by step 1):**
    *   If "dependencies" or "devDependencies" contains "next" (e.g. "next": "^13.0.0"), classify as "react" with 0.97 confidence.
    *   If "dependencies" or "devDependencies" contains "react-scripts" (e.g. "react-scripts": "5.0.1"), classify as "react" with 0.96 confidence.
    *   If "dependencies" or "devDependencies" contains "@remix-run/dev", classify as "react" with 0.95 confidence.
    *   If "dependencies" or "devDependencies" contains "vite" AND ALSO CONTAINS "@vitejs/plugin-react" or "@vitejs/plugin-react-swc", classify as "react" with 0.94 confidence.
    *   Examine the "scripts" section:
        *   If a script value starts with "next " (e.g., "next dev", "next build"), classify as "react" with 0.93 confidence.
        *   If a script value starts with "react-scripts " (e.g., "react-scripts start", "react-scripts build"), classify as "react" with 0.92 confidence.
        *   If a script value starts with "remix " (e.g., "remix dev", "remix build"), classify as "react" with 0.91 confidence.
        *   If a script value uses "vite" (e.g., "vite", "vite build") AND the 'package.json' dependencies/devDependencies indicate React (e.g. "@vitejs/plugin-react"), classify as "react" with 0.90 confidence.
3.  **If analyzing 'package.json' and NONE of the above 'react' conditions are met, classify as "static" with 0.9 confidence.** This implies it might be a Node.js project serving static files or a non-React frontend project.

**PRIORITY 2: Analysis IF '{{{fileNameAnalyzed}}}' is 'index.html' (AND no 'package.json' was found or 'package.json' analysis resulted in 'static'):**
If '{{{fileNameAnalyzed}}}' is 'index.html':
1.  Look for BOTH a script tag importing React from a CDN (e.g., <script src=".../react.development.js"></script> AND <script src=".../react-dom.development.js"></script>) AND a root div (e.g., <div id="root"></div> or <div id="app"></div>).
2.  If BOTH conditions from step 1 are met, classify as "react" with 0.6 confidence. (This is a weaker signal).
3.  Otherwise (e.g. a standard complete HTML page without clear React CDN usage), classify as "static" with 0.95 confidence.

**Default/Uncertainty:**
If 'fileContents' is not clearly identifiable or the file is not 'package.json' or 'index.html', and no strong signals are present, lean towards "static" with 0.5 confidence.

Output JSON matching the defined schema.

File Contents ('{{{fileNameAnalyzed}}}'):
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
    if (!output) {
      // Fallback in case AI fails to return valid JSON
      return { framework: 'static', confidence: 0.1 };
    }
    return output;
  }
);

