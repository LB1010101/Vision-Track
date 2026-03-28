import { ReactNode } from "react";
import { Crosshair } from "lucide-react";

export function Layout({ children }: { children: ReactNode }) {
  return (
    <div className="min-h-screen bg-background text-foreground grid-pattern relative overflow-hidden flex flex-col">
      <div className="absolute top-0 left-1/2 -translate-x-1/2 w-full max-w-4xl h-[500px] bg-primary/5 blur-[120px] rounded-full pointer-events-none" />

      <header className="border-b border-border bg-card/90 backdrop-blur-md sticky top-0 z-50 shadow-sm">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 h-16 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="relative flex items-center justify-center w-10 h-10 rounded-xl bg-primary/10 border border-primary/20">
              <Crosshair className="w-5 h-5 text-primary animate-pulse-slow" />
              <div className="absolute inset-0 border border-primary/30 rounded-xl animate-ping opacity-20" style={{ animationDuration: '3s' }} />
            </div>
            <div>
              <h1 className="text-xl font-display font-bold tracking-widest leading-none" style={{ color: 'inherit', background: 'none', WebkitBackgroundClip: 'unset', WebkitTextFillColor: 'unset' }}>
                <span className="text-foreground">VISION</span><span className="text-primary">TRACK</span>
              </h1>
              <p className="text-[10px] uppercase font-mono tracking-widest text-muted-foreground leading-none mt-1">Analytics Pipeline</p>
            </div>
          </div>

          <div className="flex items-center gap-4">
            <div className="flex items-center gap-2 px-3 py-1.5 rounded-full bg-success/10 border border-success/20">
              <div className="w-2 h-2 rounded-full bg-success animate-pulse" />
              <span className="text-xs font-mono text-success uppercase tracking-wider font-semibold">System Online</span>
            </div>
          </div>
        </div>
      </header>

      <main className="flex-1 max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8 w-full z-10">
        {children}
      </main>
    </div>
  );
}
