# Mirrors the justfile for people without `just`. BROWSER_FLAGS=--with-deps on CI-style hosts.
.PHONY: setup wasm lint test build serve dev

setup:
	npm --prefix web ci
	npm --prefix web exec playwright install $(BROWSER_FLAGS) chromium

wasm:
	wasm-pack build crates/wasm --target web --dev

lint:
	cargo fmt --all --check
	cargo clippy --workspace --all-targets -- -D warnings

test: lint wasm
	cargo test --workspace
	npm --prefix web test

build:
	wasm-pack build crates/wasm --target web --release
	npm --prefix web run build

serve: build
	npm --prefix web run preview

dev: wasm
	npm --prefix web run dev
