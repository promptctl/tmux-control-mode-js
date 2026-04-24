set shell := ["zsh", "-cu"]

default:
  @just --list

demo:
  npm run demo

demo-watch:
  npm --workspace tmux-control-mode-js-demo-web-multiplexer run dev:watch
