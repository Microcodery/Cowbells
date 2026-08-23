set shell := ["bash", "-euo", "pipefail", "-c"]

default: test

# Build the wasm package consumed by web/ (profile: --dev or --release).
wasm profile="--dev":
    wasm-pack build crates/wasm --target web {{profile}}

# One-time: wasm target, wasm-pack, web deps, and a headless browser. CI passes "--with-deps".
# Without rustup, install your distro's wasm32 std package (e.g. libstd-rust-dev-wasm32).
setup browser_flags="":
    if command -v rustup >/dev/null; then rustup target add wasm32-unknown-unknown; fi
    command -v wasm-pack >/dev/null || cargo install wasm-pack --locked
    npm --prefix web ci
    npm --prefix web exec playwright install {{browser_flags}} chromium

lint:
    cargo fmt --all --check
    cargo clippy --workspace --all-targets -- -D warnings

test: lint wasm
    cargo test --workspace
    npm --prefix web test

build: (wasm "--release")
    npm --prefix web run build

# Serve the production build from web/dist.
serve: build
    npm --prefix web run preview

# Vite dev server with hot reload.
dev: wasm
    npm --prefix web run dev
