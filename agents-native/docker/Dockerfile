# Toolchain and runtime deps only: probe.sh builds the mounted source, so a Rust edit does not rebake the image.
FROM rust:1-bookworm
ENV DEBIAN_FRONTEND=noninteractive
RUN apt-get update && apt-get install -y --no-install-recommends \
      libwebkit2gtk-4.1-dev libgtk-3-dev libayatana-appindicator3-dev librsvg2-dev libsoup-3.0-dev \
      libjavascriptcoregtk-4.1-dev build-essential pkg-config libssl-dev file \
      nodejs npm \
      xvfb xauth openbox wmctrl xdotool imagemagick dbus dbus-x11 procps jq fonts-dejavu-core \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /build
