# ADR-0001: Tech stack — Tauri 2 + Rust + React + Tailwind

- **Status:** Accepted
- **Date:** 2026-08-12

## Context

Need a local-first desktop app for comic container IO + GPU sidecar upscaling.

## Decision

- **Shell:** Tauri 2
- **Core:** Rust crates (`comic-core`, `comic-engines`, `comic-cli`)
- **UI:** React + TypeScript + **Tailwind CSS**
- **Engine:** waifu2x-ncnn-vulkan sidecar (mock for dev/CI)

## Consequences

- No Electron Chromium bundle
- Core has zero Tauri dependency (CLI + tests share logic)
- UI styling via Tailwind utility classes
