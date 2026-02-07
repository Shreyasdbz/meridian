---
applyTo: "packages/bridge/src/ui/**/*.tsx,packages/bridge/src/ui/**/*.ts"
---

# Bridge UI Conventions

- Use React functional components with hooks (no class components)
- State management with Zustand stores
- Styling with Tailwind CSS utility classes
- Build with Vite
- WCAG 2.1 AA compliance target
- Keyboard navigation for all interactive elements
- Proper ARIA labels for screen reader support
- WebSocket connection to Axis for real-time streaming
- Display approval requests from Sentinel prominently
- Never display raw secrets or API keys in the UI — scrub output for credential patterns
