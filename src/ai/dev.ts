
import { config } from 'dotenv';
config();

import '@/ai/flows/detect-framework.ts';
import '@/ai/flows/suggest-project-name.ts';
import '@/ai/flows/fix-code-flow.ts'; // Added new flow
