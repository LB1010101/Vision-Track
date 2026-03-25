import { Link } from "wouter";
import { AlertTriangle } from "lucide-react";
import { Layout } from "@/components/Layout";

export default function NotFound() {
  return (
    <Layout>
      <div className="min-h-[60vh] flex flex-col items-center justify-center text-center">
        <div className="relative mb-8">
          <div className="absolute inset-0 bg-destructive/20 blur-2xl rounded-full" />
          <div className="relative w-24 h-24 rounded-2xl border-2 border-destructive/50 flex items-center justify-center bg-card/80 backdrop-blur-sm">
            <AlertTriangle className="w-12 h-12 text-destructive" />
          </div>
        </div>
        
        <h1 className="text-6xl font-display font-bold text-white mb-4 tracking-tighter">404</h1>
        <p className="text-xl font-mono text-muted-foreground mb-8">CONNECTION_LOST: Sector not found</p>
        
        <Link 
          href="/" 
          className="px-8 py-3 rounded-xl font-mono text-sm font-bold uppercase tracking-widest bg-primary/10 text-primary border border-primary/30 hover:bg-primary hover:text-primary-foreground hover:shadow-[0_0_20px_rgba(var(--primary),0.4)] transition-all duration-300"
        >
          Return to Hub
        </Link>
      </div>
    </Layout>
  );
}
