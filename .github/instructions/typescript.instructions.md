---
applyTo: "**/*.ts,**/*.tsx"
---

# TypeScript Conventions for Meridian

- Use ES modules (`import`/`export`), never CommonJS (`require`)
- Use `interface` for object shapes that may be extended with `[key: string]: unknown`
- Use `type` for unions, intersections, and primitive aliases
- Always use explicit return types on exported functions
- Use `unknown` instead of `any` — narrow at point of use
- Prefer named exports over default exports
- Use 2-space indentation, single quotes, trailing commas, semicolons
- Use UUID v7 (time-sortable) for all entity IDs
- Group imports: 1) Node built-ins, 2) external packages, 3) `@meridian/*`, 4) relative
- Error handling: throw typed errors at source, catch at boundaries (Axis handlers, API endpoints)
- For interfaces following the loose schema principle, always include the required fields AND `[key: string]: unknown`
