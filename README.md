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
- Tasks: [GitHub Issues](https://github.com/range-et/slate/issues)
- Philosophy: [docs/motivation.md](docs/motivation.md)

## Try it

```bash
npm install && npm --prefix vscode-extension install
npm run dev                 # canvas in the browser with demo data
npm run package-extension   # build a VSIX; see vscode-extension/README.md
npm run demo:llama          # local llama.cpp loop; see DEMO.md
```

Development workflow: [DEV.md](DEV.md).

## Web Showcase & Landing Page

GitHub Pages deploys the Monad-themed product page and interactive web canvas demo at [https://range-et.github.io/slate/](https://range-et.github.io/slate/). You can explore the full XYFlow node canvas directly in your browser without local installation via `./harness.html?demo`.

## License

Slate uses a dual-license model:

- **Software & Source Code**: [PolyForm Noncommercial License 1.0.0](LICENSE.md#1-software-code--polyform-noncommercial-license-100) (free for personal, educational, research, and noncommercial development).
- **Graphics, Branding & Documentation**: [Creative Commons Attribution-NonCommercial 4.0 International (CC BY-NC 4.0)](LICENSE.md#2-graphics-branding--documentation--cc-by-nc-40) (Indrajeet Haldar).

See [LICENSE.md](LICENSE.md) for full terms.
