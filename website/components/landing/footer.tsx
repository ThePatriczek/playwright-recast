export function Footer() {
  return (
    <footer className="border-t border-fd-border px-6 py-12">
      <div className="mx-auto flex max-w-5xl flex-col items-center gap-4 text-center">
        <span className="text-sm font-semibold text-fd-foreground">
          playwright-recast
        </span>

        <div className="flex items-center gap-6 text-sm text-fd-muted-foreground">
          <a
            href="https://github.com/ThePatriczek/playwright-recast"
            target="_blank"
            rel="noopener noreferrer"
            className="cursor-pointer transition-colors duration-150 hover:text-fd-foreground"
          >
            GitHub
          </a>
          <a
            href="https://www.npmjs.com/package/playwright-recast"
            target="_blank"
            rel="noopener noreferrer"
            className="cursor-pointer transition-colors duration-150 hover:text-fd-foreground"
          >
            npm
          </a>
          <a
            href="https://github.com/ThePatriczek/playwright-recast/blob/main/LICENSE"
            target="_blank"
            rel="noopener noreferrer"
            className="cursor-pointer transition-colors duration-150 hover:text-fd-foreground"
          >
            MIT License
          </a>
        </div>

        <p className="text-xs text-fd-muted-foreground/70">
          Built with{' '}
          <a
            href="https://fumadocs.vercel.app"
            target="_blank"
            rel="noopener noreferrer"
            className="cursor-pointer underline underline-offset-4 transition-colors duration-150 hover:text-fd-muted-foreground"
          >
            Fumadocs
          </a>
        </p>
      </div>
    </footer>
  )
}
