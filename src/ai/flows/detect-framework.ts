
// src/ai/flows/detect-framework.ts
'use server';
/**
 * @fileOverview AI agent that detects framework, suggests build command and output directory.
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
  reasoning: z.string().optional().describe('A brief explanation of why this framework was chosen.'),
  build_command: z.string().optional().describe('Suggested build command if framework is "react" (e.g., "npm run build", "next build", "vite build"). Omit if "static".'),
  output_directory: z.string().optional().describe('Suggested output directory if framework is "react" (e.g., "build", "dist", ".next", "out"). Omit if "static".')
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
You also need to suggest the appropriate build command and output directory if it's a React project.
The input 'fileContents' is from the file named '{{{fileNameAnalyzed}}}'.

Your primary goal is to accurately classify the project. Provide 'framework', 'confidence', 'reasoning', and if applicable, 'build_command' and 'output_directory'.

**PRIORITY 1: Analyzing 'package.json' (if '{{{fileNameAnalyzed}}}' contains 'package.json')**
If '{{{fileNameAnalyzed}}}' is a 'package.json' file:
1.  **Next.js**:
    *   If "dependencies" or "devDependencies" contains "next": Classify as "react", confidence 0.98. Reasoning: "Next.js dependency found." build_command: "npm run build" (or "next build" if script exists), output_directory: ".next".
2.  **Create React App (react-scripts)**:
    *   If "dependencies" or "devDependencies" contains "react-scripts": Classify as "react", confidence 0.97. Reasoning: "Create React App (react-scripts) dependency found." build_command: "npm run build", output_directory: "build".
3.  **Vite with React**:
    *   If "dependencies" or "devDependencies" contains "vite" AND ("@vitejs/plugin-react" or "@vitejs/plugin-react-swc"): Classify as "react", confidence 0.96. Reasoning: "Vite with React plugin detected." build_command: "npm run build" (or "vite build" if script exists), output_directory: "dist".
4.  **Remix**:
    *   If "dependencies" or "devDependencies" contains "@remix-run/dev" or "remix": Classify as "react", confidence 0.95. Reasoning: "Remix dependency found." build_command: "npm run build" (or "remix build" if script exists), output_directory: "public/build" (or sometimes "build").
5.  **Generic React (Core Dependencies)**:
    *   If "dependencies" or "devDependencies" contains BOTH "react" AND "react-dom" (and not caught by above specific frameworks): Classify as "react", confidence 0.90. Reasoning: "Found react and react-dom in dependencies." build_command: "npm run build" (if a 'build' script likely using webpack/parcel/etc. exists), output_directory: "dist" or "build" (less certain, try "dist" first).
6.  **React-Related Scripts (if not caught by dependencies)**:
    *   Examine "scripts" section:
        *   If a script value starts with "next " (e.g., "next build"): Reinforce Next.js detection.
        *   If a script value starts with "react-scripts " (e.g., "react-scripts build"): Reinforce CRA detection.
        *   If a script value uses "vite" and a react plugin is present: Reinforce Vite detection.
7.  **If analyzing 'package.json' and NONE of the above 'react' conditions are met**: Classify as "static", confidence 0.9. Reasoning: "package.json present but no clear React indicators, build command, or output directory found; likely a Node.js project or non-React frontend." Omit 'build_command' and 'output_directory'.

**PRIORITY 2: Analyzing 'index.html' (if '{{{fileNameAnalyzed}}}' contains 'index.html' AND no 'package.json' was prioritized)**
If '{{{fileNameAnalyzed}}}' is an 'index.html' file:
1.  **CDN React Usage**:
    *   Look for script tags importing BOTH React AND React-DOM AND a typical root div (e.g., <div id="root"></div> or <div id="app"></div>).
    *   If ALL these conditions are met: Classify as "react", confidence 0.6. Reasoning: "React and ReactDOM loaded via CDN with a root element." Omit 'build_command' and 'output_directory' as it's likely pre-built or doesn't have a standard build step.
2.  **Standard HTML Page**:
    *   Otherwise: Classify as "static", confidence 0.95. Reasoning: "Standard index.html without clear React CDN indicators." Omit 'build_command' and 'output_directory'.

**Default/Uncertainty:**
If 'fileContents' is not clearly identifiable based on the above, or if '{{{fileNameAnalyzed}}}' is neither 'package.json' nor 'index.html':
*   Classify as "static", confidence 0.5. Reasoning: "Unable to determine framework with high confidence; defaulting to static." Omit 'build_command' and 'output_directory'.

Output JSON matching the defined schema. Ensure 'build_command' and 'output_directory' are only provided for "react" framework type where applicable.

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
