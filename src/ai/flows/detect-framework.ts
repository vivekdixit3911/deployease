
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
    .describe('The contents of the project file being analyzed. This will be the content of package.json (highest priority if found) or index.html (if package.json is not found).'),
  fileNameAnalyzed: z.string().describe("The relative path/name of the file whose content is being analyzed (e.g., 'package.json', 'my-project/package.json', or 'index.html', 'src/index.html')."),
});
export type DetectFrameworkInput = z.infer<typeof DetectFrameworkInputSchema>;

const DetectFrameworkOutputSchema = z.object({
  framework: z
    .enum(['react', 'static'])
    .describe('The detected framework type: "react" or "static".'),
  confidence: z.number().min(0).max(1).describe('The confidence level of the detection (0.0 to 1.0).'),
  reasoning: z.string().optional().describe('A brief explanation of why this framework was chosen, especially if "react" was detected due to specific dependencies or scripts, or if "static" was chosen due to lack of React indicators.')
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

Your primary goal is to accurately classify the project. Provide a confidence score and a brief reasoning.

**PRIORITY 1: Analyzing 'package.json' (if '{{{fileNameAnalyzed}}}' contains 'package.json')**
If '{{{fileNameAnalyzed}}}' is a 'package.json' file:
1.  **React Core Dependencies**:
    *   If "dependencies" or "devDependencies" contains BOTH "react" AND "react-dom": Classify as "react" with 0.98 confidence. Reasoning: "Found react and react-dom in dependencies."
2.  **React Frameworks/Build Tools (if not caught by step 1)**:
    *   If "dependencies" or "devDependencies" contains "next": Classify as "react" with 0.97 confidence. Reasoning: "Next.js dependency found."
    *   If "dependencies" or "devDependencies" contains "react-scripts": Classify as "react" with 0.96 confidence. Reasoning: "Create React App (react-scripts) dependency found."
    *   If "dependencies" or "devDependencies" contains "@remix-run/dev" or "remix": Classify as "react" with 0.95 confidence. Reasoning: "Remix dependency found."
    *   If "dependencies" or "devDependencies" contains "vite" AND ALSO CONTAINS "@vitejs/plugin-react" or "@vitejs/plugin-react-swc": Classify as "react" with 0.94 confidence. Reasoning: "Vite with React plugin detected."
3.  **React-Related Scripts (if not caught by above)**:
    *   Examine "scripts" section for keys like "dev", "start", "build":
        *   If a script value starts with "next " (e.g., "next dev"): Classify as "react" with 0.93 confidence. Reasoning: "Next.js script found."
        *   If a script value starts with "react-scripts " (e.g., "react-scripts start"): Classify as "react" with 0.92 confidence. Reasoning: "react-scripts script found."
        *   If a script value starts with "remix " (e.g., "remix dev"): Classify as "react" with 0.91 confidence. Reasoning: "Remix script found."
        *   If a script value uses "vite" (e.g., "vite", "vite build") AND 'package.json' (dependencies/devDependencies) indicates React (e.g. "@vitejs/plugin-react"): Classify as "react" with 0.90 confidence. Reasoning: "Vite script with React plugin dependency found."
4.  **If analyzing 'package.json' and NONE of the above 'react' conditions are met**: Classify as "static" with 0.9 confidence. Reasoning: "package.json present but no clear React indicators found; likely a Node.js project or non-React frontend."

**PRIORITY 2: Analyzing 'index.html' (if '{{{fileNameAnalyzed}}}' contains 'index.html' AND no 'package.json' was prioritized)**
If '{{{fileNameAnalyzed}}}' is an 'index.html' file:
1.  **CDN React Usage**:
    *   Look for script tags importing BOTH React (e.g., <script src=".../react.development.js"></script>) AND React-DOM (e.g., <script src=".../react-dom.development.js"></script>) AND a typical root div (e.g., <div id="root"></div> or <div id="app"></div>).
    *   If ALL these conditions are met: Classify as "react" with 0.6 confidence. Reasoning: "React and ReactDOM loaded via CDN with a root element."
2.  **Standard HTML Page**:
    *   Otherwise (e.g., a standard complete HTML page without clear React CDN usage, or only one of React/ReactDOM CDN links): Classify as "static" with 0.95 confidence. Reasoning: "Standard index.html without clear React CDN indicators."

**Default/Uncertainty:**
If 'fileContents' is not clearly identifiable based on the above, or if '{{{fileNameAnalyzed}}}' is neither 'package.json' nor 'index.html' (which shouldn't happen based on upstream logic, but as a fallback):
*   Classify as "static" with 0.5 confidence. Reasoning: "Unable to determine framework with high confidence from the provided file; defaulting to static."

Output JSON matching the defined schema, including 'framework', 'confidence', and 'reasoning'.

File Content ('{{{fileNameAnalyzed}}}'):
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
    if (!output || !output.framework) {
      // Fallback in case AI fails to return valid JSON or essential fields
      return { framework: 'static', confidence: 0.1, reasoning: "AI output was malformed or missing, defaulted to static." };
    }
    return output;
  }
);

