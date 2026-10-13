# Slate

A node canvas for composing Python with a local LLM, aiming at the feel of
Grasshopper, Blender Geometry Nodes, or Unreal Blueprints. Functions are nodes
on one large workspace. You write small leaf functions, or let a local
llama.cpp model draft them, and wire them together yourself.

**Status:** early. The VS Code extension indexes Python into a source-linked
canvas with search, notes, explicit context, and a reviewed single-function
llama.cpp loop. Wiring, reference nodes, groups, and live values are planned.

- What exists: [features.md](features.md)
- Where it's going and why: [SLATE_HARNESS_PLAN.md](SLATE_HARNESS_PLAN.md)
- Tasks: [issues.md](issues.md)
- Philosophy: [legacy/motivation.md](legacy/motivation.md)

## Try it

```bash
npm install && npm --prefix vscode-extension install
npm run dev                 # canvas in the browser with demo data
npm run package-extension   # build a VSIX; see vscode-extension/README.md
npm run demo:llama          # local llama.cpp loop; see DEMO.md
```

Development workflow: [DEV.md](DEV.md).

## Legacy notebook

The original browser card notebook is frozen in [legacy/](legacy/README.md).
GitHub Pages keeps deploying it until the harness replaces it.

## License

CC BY-NC-ND 4.0 (Indrajeet Haldar)
