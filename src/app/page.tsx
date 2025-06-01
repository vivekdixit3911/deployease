// src/app/page.tsx
import { UploadCard } from '@/components/deploy-ease/UploadCard';
import { Github } from 'lucide-react'; 

export default function HomePage() {
  return (
    <div className="min-h-screen flex flex-col items-center justify-center bg-background p-4 sm:p-8 font-body">
      <header className="mb-10 text-center">
        <h1 className="text-5xl font-headline font-bold text-primary tracking-tight">
          DeployEase
        </h1>
        <p className="mt-3 text-xl text-foreground/80 max-w-2xl">
          Effortlessly deploy your React and static web projects. Just upload a ZIP, and we&apos;ll take care of the magic!
        </p>
      </header>

      <main className="w-full flex justify-center">
        <UploadCard />
      </main>

      <footer className="mt-12 text-center text-sm text-muted-foreground">
        <p>&copy; {new Date().getFullYear()} DeployEase. All rights reserved.</p>
        <a 
            href="https://github.com" 
            target="_blank" 
            rel="noopener noreferrer" 
            className="inline-flex items-center hover:text-primary transition-colors mt-2"
        >
            <Github className="h-4 w-4 mr-1" />
            View on GitHub
        </a>
      </footer>
    </div>
  );
}
