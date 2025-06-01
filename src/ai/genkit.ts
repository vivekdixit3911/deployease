import {genkit} from 'genkit';
import {googleAI} from '@genkit-ai/googleai';

// Ensure that dotenv is configured to load environment variables
// This is typically done in your entry point or a central config file.
// For Next.js, .env.local or .env is automatically loaded.
// For Genkit dev server (src/ai/dev.ts), ensure `dotenv.config()` is called.

const geminiApiKey = process.env.GEMINI_API_KEY;

if (!geminiApiKey) {
  console.warn(
    'GEMINI_API_KEY is not set in environment variables. Genkit Google AI plugin might not work as expected.'
  );
}

export const ai = genkit({
  plugins: [
    googleAI({
      apiKey: geminiApiKey,
    }),
  ],
  model: 'googleai/gemini-2.0-flash',
});
