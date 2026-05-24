set shell := ["zsh", "-cu"]

default:
  @just --list

demo:
  pnpm run demo

demo-watch:
  pnpm --filter tmux-control-mode-js-demo-web-multiplexer run dev:watch

demo-electron:
  pnpm --filter tmux-control-mode-js-demo-web-multiplexer run demo:electron
